# Design: A run is never started past its input, and a failed run does not end production

Line numbers are at proxy `origin/main` `e274d06f` (2.107.72); re-locate by name.
Log anchors are lines of meta
`research/session-logs-2026-11-09-ttv289/proxy-tail.log.gz` (gunzipped, `sed -n`)
and `client-164215.log.gz`.

## 1. Findings

### 1.1 Facts

Versions:

1. HA add-on 0.100.66 installs proxy 2.107.65 (ha-addon `CHANGELOG.md`,
   "0.100.66"; commit `d2a1140 fix(proxy): install proxy 2.107.65`).
2. `git diff --quiet v2.107.65 origin/main -- services/encode
   services/server/SegmentServing.js services/server/transcode-session-files.js`
   exits 0: nothing on the paths below changed up to 2.107.72. The changes in
   between (#281 loopback forward, #282 byte ranges, #302 native build, #309
   test helpers, #326 docs) touch `routes/{stream,media,encode-input}`,
   `services/server/byte-range-reply.js`, `services/server/wire-outputs.js`
   (wiring of the forwarder and viewer relations only), `services/transport/`
   and `services/viewer/choices.js`.

Proxy log, video output `torrent:cfbe…:video-only:v=0/copy`, session
`eb7ef267eeed1c8a`:

| line | time | text (shortened) |
|---|---|---|
| 115747 | 16:44:57.363 | `encode input #187..#263 …: needs-bytes (… for #187 …)` |
| 115770 | 16:44:58.242 | `encode input selection …: {"from":187,"requestedTo":263,"serves":187,"floor":187,"targetEnd":187,"chosenEnd":187,…}` |
| 115771 | 16:44:58.243 | `encode input #187..#263 …: ready #187..#187, 29866921 bytes` |
| 115772 | 16:44:58.253 | `encode input selection …: {"from":186,…,"serves":187,"floor":187,…,"chosenEnd":187}` |
| 115774 | 16:44:58.259 | `encode-run #187..#187 … by libx264: #187 is wanted …` (input #186..#187) |
| 115796 | 16:44:58.546 | `encode-plan …: move #188..#263, keep #187..#187` |
| 115798 | 16:44:58.552 | `encode-run #188..#187 … by libx264: standing at #187 scores worse than standing at #188 …` |
| 115850 | 16:45:00.254 | `encode input #188..#263 …: needs-bytes (… for #188 …)` |
| 115853 | 16:45:00.642 | `run-state #187..#187 … STARTING --FIRST_SEGMENT--> PRODUCING` |
| 115857 | 16:45:00.677 | `run-state #187..#187 … PRODUCING --EXITED_COMPLETE--> ENDED_COMPLETE` |
| 115887 | 16:45:01.584 | `run-state #188..#187 … PRODUCING --EXITED_SHORT--> ENDED_FAILED` |
| 115888 | 16:45:01.584 | `encode-run short #188..#187 …, reached #187 (0 segment(s)) after 3033ms, code 0: it exited cleanly at #187 of #187 — its input stopped` |
| — | 16:45:03.061 | `encode input storage of run #188..#187 …: input 29866921 bytes` (the #187..#187 stretch of line 115771) |
| 115893 | 16:45:01.608 | `encode-plan …: start #188..#263 [… maxRuns=1 live=0]` |
| 115894 | 16:45:01.609 | `encode: no encoder could be made for #188..#263 …` |
| — | 16:45:02.511 | `[dc] GET /transcode/eb7ef267eeed1c8a/v/1080/segment-00188.mp4 …` |
| — | 16:45:02.533 | `[hold] segment-00188.mp4 failed after 4ms` |
| — | 16:45:02.538 | `… v/1080/segment-00188.mp4 … → 500` |

Audio output `audio-only:a=0/0/aac`, session `5ca232a583712c39`: its run
#187..#187 ended `ENDED_COMPLETE` (16:45:01.613); `encode: no encoder could be
made for #188..#263` (16:45:01.624); its request for segment-00188 was held
(`holding segment-00188.mp4: the file is not on disk (… encoder stopped …)`,
16:45:02.530) and cancelled when the page closed the connection
(16:45:02.567); its input #188..#263 was then `withdrawn: no wanted window
covers it` (16:45:02.598).

Whole log: 1562 `encode-run #A..#B of … by` lines, 52 of them with `B < A`
(first: `encode-run #34..#33`, 22:22:05.482, another film). The one checked
whole (#34..#33) follows the same order: input `{"from":33,…,"serves":33,
"chosenEnd":33}` (22:22:05.449), run `#34..#33`, `EXITED_SHORT` with 0
segments (22:22:08.572); there the next plan found input #34 ready and started
`#34..#34` at once (22:22:08.602), so no request was failed.

Page log `client-164215.log.gz`: last line 16:45:01.332; it ends before the
500 and holds no `fragLoadError` line (the issue cites it from the page's
screen and the proxy's `→ 500`).

Code:

1. `EncodeRuns.#startEncodeRun` (`services/encode/EncodeRuns.js:966–1006`):
   `inputStart = fromKeyframeBefore ? startIndex - 1 : startIndex`;
   `admittedInput = encodeInputs.take(session, inputStart, mayReach, startIndex)`;
   `inputEnd = admittedInput.original ? admittedInput.to : startIndex`; the run
   is built with `from: safeIndex` (= `startIndex` when `fromKeyframeBefore`)
   and `to: runEnd` (= `inputEnd`) (`:1144–1148`). Nothing compares
   `inputEnd` with `startIndex`.
2. `#startsAtKeyframeBefore` (`:715`) is true for #188: the piece before
   (#187) was being made by a live run.
3. `EncodeInputs.take` (`services/encode/EncodeInputs.js:258–282`): sets
   `existing.serves = serves`, then returns `existing.result` when its kind is
   `result`, whatever its `to`.
4. `#admitStretch` (`:612–617`) sets the floor to `serves` only when the
   stretch through `serves` resolves; otherwise the floor stays `from`.
5. `run.admittedInputKeys` is a map of `inputEnd - safeIndex + 1` entries
   (`:1316`): 0 entries for `#188..#187`. `noteRunEnded` (`:1529–1560`) finds no
   key for `run.head` and records nothing in `InputFailures`.
6. `EncodeOrchestrator.noteEnded` (`services/encode/EncodeOrchestrator.js:1409`)
   stores the run's state in `#lastState`; `stateOf` (`:379`) answers it when no
   run is left.
7. `EncodeRuns.runStateOf` (`:352–362`): `ENDED_FAILED` from
   `EncodeInputs.failureOf`; `ENDED_FAILED` from `InputFailures.reason` when no
   run is live; otherwise `stateOf`, turned into `IDLE` only when
   `InputFailures.retrying`.
8. `noteRunEnded` (`:1580`): `if (this.hasFailed(session))` →
   `invalidateWaits` and `productionFailed`.
9. `SegmentServing.#holdForProduction` (`services/server/SegmentServing.js:681`):
   `hasFailed` → `{ kind: "failed" }`; `transcode-session-files.js:167` answers
   it `500 { canRetry: false }`.
10. `EncodeRuns.makeRunAt` (`:766`) returns null when `#startEncodeRun`
    returns null, which includes `take` returning null (input not prepared);
    `EncodeOrchestrator.#start` (`:1229–1234`) prints `no encoder could be made`
    for every null.

### 1.2 Analysis

Question 1 — does 2.107.71/72 change it? No: fact 2; every line of code in
the chain above is the same in 2.107.65 and 2.107.72.

Question 2 — why `#188..#187` and "exited cleanly at #187 of #187", 5 Whys:

1. Why did the run make nothing? Its input ended at #187 and it was told to
   start publishing at #188 (`-ss` of #188 in a stretch that ends where #188
   begins); ffmpeg read to the end of what it was given and exited 0.
2. Why did its input end at #187? `#startEncodeRun` took the input keyed at
   #187 (keyframe before #188), and that input was the stretch #187..#187.
3. Why was that stretch only #187..#187? It had been prepared for a request
   serving #187 (log line 115770: `serves 187`, `chosenEnd 187`); the stretch
   sizing (`targetBytes 2002389` against `minimumBytes 29866921`) gives one
   piece, the least that makes the piece it serves.
4. Why was a stretch prepared for #187 used for #188? `take` changes `serves`
   and hands out the result held for the old `serves`.
5. Why is that possible? No owner states the condition "the stretch handed
   out holds the piece it is taken for": `#admitStretch` states it only while
   it prepares, and only when the stretch through `serves` resolves; `take`
   and `#startEncodeRun` do not state it. **Root cause 1.**

Question 3 — why `no encoder could be made for #188..#263` (video and audio):
`makeRunAt` returned null because `take` returned null — the input for the
start was not prepared yet. For video, the new start #188 reads from #187
(`#187` was published at 16:45:00.642, so it is "made"), and the #187 request
had been taken and released by the failed run, so a new preparation began; the
#188 request (line 115850) was `needs-bytes`. For audio, the #188 input was
pending until withdrawn at 16:45:02.598. This is a wait, not a refusal; the
line and its comment in `EncodeOrchestrator.#start` say "refusal" for both
(out of scope, see proposal). Assumption, not verified from the log: had the
viewer stayed, the input's arrival (`bytesChanged`) would have prepared it and
the plan would have started #188 — as it did at 22:22:08.602 for #34.

Question 4 — why 500 for segment-00188, 5 Whys:

1. Why 500? `#holdForProduction` found `hasFailed(session)` true.
2. Why true? `runStateOf` answered `ENDED_FAILED`: no live run, so
   `EncodeOrchestrator.stateOf` answered the last run's state.
3. Why does the last run's state decide the output's? `stateOf` falls back to
   `#lastState` when no run remains, and `runStateOf` lifts that to `IDLE`
   only for one listed case (`InputFailures.retrying`).
4. Why was that wrong here? The output's production had not ended: no
   terminal input (`failureOf` null), no failed input that will not be retried
   (`InputFailures.reason` null — fact 5), and the plan was placing the next
   run (16:45:01.608).
5. Why can a non-terminal ending read as terminal? Whether production of an
   output has ended is a fact with two owners that write it — the input
   failure records (`EncodeInputs.failureOf`, `InputFailures`) and the last
   run's state — and they disagree. **Root cause 2.** The correct answer is
   the hold: the segment is held (the page states `holdMs`) and is served when
   the next run publishes it.

Root cause 2 is not limited to an inverted run. Any failed ending that records
no input failure and leaves no run alive does the same: a hardware-encoder
failure (`failedAdmittedInput(…, hardwareEncode=true)` is false), an ending
by signal, a resource error (`ENOMEM`, `ENOSPC`, …), or a stretch whose copy
failed (`copyFailed()`), all of which the code comments describe as cases the
plan starts again.

## 2. Decisions

1. **`EncodeInputs` owns "this stretch holds the piece it is for".** The check
   lives where the stretch is handed out (`take`) and where it is sized
   (`#admitStretch`); `#startEncodeRun` and `EncodeRun` keep no second check.
2. **Production of an output ends only on a terminal input fact.** With an
   encode-input owner present, `EncodeInputs.failureOf` and
   `InputFailures.reason` are the only writers of "it will not be made". The
   last run's `ENDED_FAILED` stays the run's state (the per-run machine in
   `encode-run-state.js` is unchanged) and stops being read as the output's.
   This generalises the existing `retrying` rule (torrent-tv/meta#178) instead
   of listing one more case.
3. Nothing is chosen: no timer, no retry count, no threshold is added.

## 3. Changes, in order

### 3.1 `services/encode/EncodeInputs.js` — `take(output, from, to, serves = from)`

After the block that narrows `existing.to` and before
`if (existing?.result?.kind === "result")`:

```js
const held = existing?.result;
if (held?.kind === "result" && Number.isInteger(held.to) && held.to < serves) {
  this.#log(`encode input #${existing.from}..#${existing.to} of ${addressOf(output)}: ` +
    `the held stretch #${held.from}..#${held.to} does not reach #${serves}, the piece it is now taken for; ` +
    `prepared again`);
  existing.result = null;
  existing.noted = undefined;
  held.release?.();
  this.#prepare(existing);
  return null;
}
```

- `#prepare` is called directly: the request's `revision` equals the current
  one, and the guard `existing?.revision === this.#revision` below would
  otherwise return null with no preparation until other bytes arrive.
- `#prepare` reads `request.serves` (already set to the new value above) and
  sizes the stretch from `existing.from` with floor `serves`.
- `#wanted` and `#retryMemory` need no change: `#prepare` sets them.

### 3.2 `services/encode/EncodeInputs.js` — `#admitStretch`

Where `serves > from` (line ~614): when `at(serves)` does not resolve, the
answer is not a stretch ending below `serves`. Keep the resolution's own
answer for each `end` in `at` (today it keeps only `result` sources and
discards the kind), and when the stretch through `serves` did not resolve,
return that answer (`needs-bytes`, `needs-…`, or the terminal kind) instead of
continuing from `floor = from`. A `needs-bytes` answer must carry
`sourceKey`, `fileIndex`, `ranges` and `awaiting` as the `needs-bytes` answer
below does, so `bytesChanged` wakes it.

Postcondition of every `result` that `EncodeInputs` hands out:
`result.from <= serves <= result.to`.

### 3.3 `services/encode/EncodeRuns.js` — `runStateOf(output)`

```js
runStateOf(output) {
  if (this.#host.encodeInputs?.failureOf(output)) return ENCODE_RUN_STATE.ENDED_FAILED;
  if (output && this.liveRunsOf(output).length === 0 && this.#inputFailures.reason(output.outputKey)) return ENCODE_RUN_STATE.ENDED_FAILED;
  const state = output ? this.#host.encodeOrchestrator.stateOf(output.outputKey) : runStateOf([]);
  // PRODUCTION ENDS ONLY ON A TERMINAL INPUT FACT (torrent-tv/meta#341) …
  if (state === ENCODE_RUN_STATE.ENDED_FAILED && output && this.liveRunsOf(output).length === 0 &&
    (this.#host.encodeInputs || this.#inputFailures.retrying(output.outputKey))) return ENCODE_RUN_STATE.IDLE;
  return state;
}
```

The comment names the field case (16:45:02.538, `#188..#187`) and the two
owners of the terminal fact. Without `encodeInputs` (tests only) the existing
`retrying` rule is kept as it is.

`lastErrorOf`, `hasFailed`, `isWaitingForInput` read `runStateOf` and need no
change. `wireState` then answers `starting` for such an output (`IDLE`).

### 3.4 `services/encode/EncodeRuns.js` — `noteRunEnded`

After `this.#host.encodeOrchestrator.noteEnded(ended)` and before
`this.planEncodersSoon()`: when `ended.run?.state === ENDED_FAILED` and
`!this.hasFailed(session)`, log once per ending:

```
encode: run #<from>..#<to> of <outputKey> ended <ENDED_FAILED> (<ended.because>); production goes on — no input failure ends it, so requests for its pieces stay held
```

(`info` level; `from`/`to` from `ended`.) This is the field line of
root cause 2.

### 3.5 `docs/encode-run-state.md`

Under "What each state answers", add a short section "A run's state and its
output's state": `ENDED_FAILED` is terminal for the run; the output answers
`fail` only when `EncodeInputs.failureOf` or `InputFailures.reason` states that
the piece will not be made; a failed run with neither leaves the output `IDLE`
(held), torrent-tv/meta#341. Change the `ENDED_FAILED` row of "States" to
"Terminal for this run. The output fails only on a terminal input fact (see
below)."

### 3.6 Changeset

`.changeset/fix-ttv-341-seek-run-range.md`, rules of `proxy/AGENTS.md`
"Changesets":

```
---
"@torrent-tv/proxy": patch
---
- **Fix**: After a seek, the proxy no longer starts an encoder past the end of the input it was given (a run such as `#188..#187` that makes nothing), and a run that ends without a terminal input failure no longer makes the next segment answer 500: the request is held until the next run makes it.
```

## 4. Field log lines

| line | proves |
|---|---|
| `encode input #F..#T of <addr>: the held stretch #F..#E does not reach #S, the piece it is now taken for; prepared again` | the root-cause-1 condition happened and was handled; the next `encode-run #S..#X` has `X >= S` |
| no `encode-run #A..#B of … by` line with `B < A` | root cause 1 is gone |
| `encode: run #A..#B of <addr> ended ENDED_FAILED (…); production goes on …` followed by `[hold] segment-… file after …ms` for a piece of that output | root cause 2 is gone: a failed run leaves requests held and the piece is served |
| no `[hold] segment-… failed after …` / `… → 500` on `/transcode/…/segment-…` without an `encode: unchanged input will not be retried` or terminal `encode input … terminal` line before it for that output | no 500 without a terminal fact |

Before the fix the 2026-11-09 log reads: 52 runs with `B < A`; `failed after
4ms` and `→ 500` at 16:45:02.53 with no terminal input line for the video
output. After the fix the field check (AC-7) must read: 0 runs with `B < A`,
and no `→ 500` on a transcode segment without a terminal input line.

## 5. Risks

1. Holding instead of failing when a position fails again and again without
   an input failure record (for example an ffmpeg crash by signal each time):
   the plan already restarts there today (`planEncodersSoon` runs for every
   ending), so only the answer to the viewer changes — held up to the page's
   `holdMs` instead of a 500. The case is named, not handled here; its log is
   the new `production goes on` line repeating for the same `#A`.
2. Re-preparing a stretch copies the start piece again; for a shared
   (`commonRanges`) input most bytes are shared, not copied (line 115837:
   `copied 7740366, shared 22126555`).

## 6. Existing tests that state a failed output (amendment, 2026-11-09)

`test/no-torrent/failed-encoder-still-serves-what-exists.test.js` builds every
manager with `managerWithOwnStore`, which always supplies `fakeEncodeInputs()`
(`test/no-torrent/helpers/manager.js:53`, `failureOf: () => null`). Its fixture
`outputWhoseEncoderDied({ failed: true })` makes the output fail only by
`encodeOrchestrator.noteEnded({ run: { state: ENDED_FAILED } })`, which is the
non-terminal ending this change stops reading as the output's failure (§3.3).
Six of its tests then fail. The decision per test, from the target behaviour:

| test | decision |
|---|---|
| "a segment that is on disk is served although the encoder failed" | keeps its meaning (a failed output still serves what is made). Rewrite the setup: terminal fact supplied by the fixture (below). Assertions unchanged. |
| "a segment that is not there says the encoder failed, instead of being held" | keeps its meaning (a missing piece of a failed output is answered `failed`). Fixture below; `assert.match(answer.message, /255/)` becomes `/source-input-exceeds-memory-capacity/` (`lastErrorOf` answers `<reason>: <message>` of the terminal input). |
| "the playlist is a fact of the timeline and outlives the encoder" | keeps its meaning. Fixture below; assertions unchanged. |
| "a failure reaches a request that was ALREADY waiting" | keeps its meaning (a wait begun before a terminal failure is told). Rewrite the setup: build the manager with `failureOf` answering the terminal input once a flag is set, and set the flag immediately before `child.exit(255)`; the run's ending then finds the terminal fact. Assertions unchanged. |
| "a run that exits 0 having produced less than promised also reaches a waiting request" | states the bug (a short ending with no input failure fails the output). Delete it. Its corrected form is already the AC-4 test "a request held while the only run ends short is served when a later run publishes the segment" (`failed-run-production-goes-on.test.js`); a second copy is not written. |
| "an init that will never be made says so instead of warming up for ever" | keeps its meaning. Fixture below; `/255/` becomes `/source-input-exceeds-memory-capacity/`. |

"one run of two ending in failure tells nobody — the other is still making it"
passes before and after and is not changed.

Fixture change, `outputWhoseEncoderDied({ failed: true })`: build the manager
with `managerWithOwnStore({ planless: true, encodeInputs: { ...fakeEncodeInputs(),
failureOf: (output) => output.id === SESSION_ID ? TERMINAL : null } })`, where
`TERMINAL = { kind: "terminal", reason: "source-input-exceeds-memory-capacity",
message: "one piece is larger than memory" }` (the shape `EncodeInputs` answers,
`services/encode/EncodeInputs.js` `#admitStretch`). Keep the `noteEnded` call
and the assertion `hasFailed(session) === true`. With `failed: false` the
manager keeps `failureOf: () => null`. The file's header comment gains one
sentence: an output fails only on a terminal input fact (torrent-tv/meta#341).
