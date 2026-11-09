# Proposal: A run is never started past its input, and a failed run does not end production

Issue: torrent-tv/meta#341.

## Why

Field check of #289 on 2026-11-09 (HA add-on 0.100.66 = proxy 2.107.65; logs in
meta `research/session-logs-2026-11-09-ttv289/`). After a seek to 1927 s the
page released the picture with 20.6 s buffered (page log 16:45:01.274) and
1.3 s later the proxy answered the next video segment with
`GET …/v/1080/segment-00188.mp4 → 500` (proxy log 16:45:02.538). A 500 carries
`canRetry: false` (`services/server/transcode-session-files.js`), so the page
stopped with "The video player stopped and can't continue".

Two defects lead there; each is a cause, not a consequence (5 Whys in
`design.md` §1).

1. **A run is started at a piece its input does not hold.** A picture copied
   from the original file is read from the keyframe before its start
   (`EncodeRuns.#startsAtKeyframeBefore`). The run for #188 therefore took the
   input keyed at #187 (`EncodeInputs.take(output, 187, 263, 188)`). That input
   had been prepared earlier for a run serving #187 and held the stretch
   #187..#187 (`encode input selection … {"from":187,…,"serves":187,…,"chosenEnd":187}`,
   16:44:58.242). `take` updates the request's `serves` to 188 but hands out the
   held stretch without checking that it reaches #188. The run is built with
   `from = 188`, `to = 187` (`encode-run #188..#187 …`, 16:44:58.552); ffmpeg
   is spawned, reads 26.6 MB, makes nothing and exits 0
   (`EXITED_SHORT --> ENDED_FAILED`, "exited cleanly at #187 of #187 — its input
   stopped", 16:45:01.584). The same log holds 52 such runs out of 1562
   (`encode-run #34..#33`, `#36..#35`, … on another film, 22:22–22:23); each costs
   an ffmpeg start and about 3 s of the machine.
2. **A failed run with no run left beside it ends the output's production.**
   With no live run, `EncodeOrchestrator.stateOf` answers the last run's state
   (`ENDED_FAILED`), `EncodeRuns.runStateOf` passes it on, `hasFailed` is true,
   `noteRunEnded` invalidates every held request and `SegmentServing` answers a
   missing segment with `{ kind: "failed" }` → 500. No terminal fact stood
   behind it: the input failure record (`InputFailures`) held nothing for this
   run (its stretch map was empty, `from > to`), `EncodeInputs.failureOf` was
   null, and the plan was already starting the next run (`encode-plan … start
   #188..#263`, 16:45:01.608) whose input was being prepared. Production had not
   ended; the answer said it had.

For the viewer: after a seek the film stops with a fatal error although every
piece of it can still be made. The rule (`meta/AGENTS.md`, "Product rules") is
that the viewer sees playback continue; a request for a piece that is not
ready is held or answered with a retryable 503, never failed while it can
still be made (`proxy/AGENTS.md`, "HLS is VOD").

## What changes

- `services/encode/EncodeInputs.js` `take`: a held stretch whose last piece is
  below the piece it is now taken for (`serves`) is not handed out: it is
  released, the request is prepared again with that `serves`, and one line
  says so. `#admitStretch` never answers a stretch ending below `serves`.
- `services/encode/EncodeRuns.js` `runStateOf`: with an encode-input owner
  present, a last run that ended `ENDED_FAILED` makes the output `IDLE` (held,
  production goes on) unless a terminal fact says it will not be made:
  `EncodeInputs.failureOf` or `InputFailures.reason`. Those two rules already
  decide terminal failure; the fallback to the last run's state stops being a
  third, unstated one. `noteRunEnded` logs one line when a failed run leaves
  production going on.
- `docs/encode-run-state.md`: the difference between a run's `ENDED_FAILED`
  and the output's state is written down.
- A changeset (`fix`).

## Out of scope

- Whether the run for #188 should read from the keyframe before at all
  (`#startsAtKeyframeBefore`, torrent-tv/meta#178): unchanged.
- The wording of `encode: no encoder could be made for …`
  (`EncodeOrchestrator.#start`): it is printed both when the start is refused
  and when its input is still being prepared (`take` returned null), and its
  comment calls every case "a refusal, not a wait". In this incident it meant
  "the input for #188 is being prepared". Changing the line needs a reason
  carried out of `makeRunAt`; it is a separate follow-up.
- The page: it treated a 500 with `canRetry: false` as fatal, as specified.
- Outputs without an encode-input owner (`encodeInputs` absent): only tests
  build them; production always constructs one (`server.js` passes
  `encodeInputResolution`, `services/server/wire-outputs.js` builds
  `EncodeInputs` from it). Their failure handling (`mayStartAt`) is unchanged.
- How long a held request waits: the page states it (`holdMs`); unchanged.
