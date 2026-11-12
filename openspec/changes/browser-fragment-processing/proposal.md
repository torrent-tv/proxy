# Proposal: The readiness schedule charges the browser's processing of each fragment

Issues: torrent-tv/meta#260 (this change), parent torrent-tv/meta#185.
Paired server change: `server/openspec/changes/append-execute-span`.

## Why

`predictPlaybackReadiness` (`services/viewer/playback-readiness.js`) decides
when a waiting viewer can start without a stop. It schedules, per fragment,
source arrival, production and delivery over the link, and then adds
`appendSeconds`, the browser's work before the fragment is playable. No caller
supplies `appendSeconds` (`ViewerRequests.#playbackReadinessFor` never sets it),
so the term is always 0 (`transferJobs.push({ …, appendSeconds:
finiteNonNegative(track.appendSeconds) })`). The browser already reports the
measurements this term needs (`appendService`, `fragmentService` in each net
report); the proxy keeps them only as log evidence
(`firstRequiredStages[].observedBrowserWork`, `evidenceOnly: true`).

The work is not small and it is not only per fragment:

1. Measured in the field (meta `research/forecast-atomic-audit-2026-10-24-ttv185.md`,
   section 5): first picture fragment append acknowledgement 35.4 ms, first
   soundtrack fragment 13.0 ms, first soundtrack fragment load-to-parsed
   847.5 ms, a later one 3.7 ms.
2. hls.js 1.7.4 (the version the server serves) requests a stream's next
   fragment only after the previous one is buffered: a stream controller stays
   in `PARSED` after `FRAG_PARSED` (`base-stream-controller.ts`, `this.state =
   State.PARSED`) and returns to `IDLE`, where `doTickIdle` loads the next
   fragment, only in `onFragBuffered` (`stream-controller.ts`). The schedule
   today lets a track's next transfer start as soon as its previous delivery
   ends (`scheduleTransfers`, `trackFreeAt.set(trackIndex, deliveryAt)`). So the
   browser's processing delays every later fragment of that track, and the
   forecast is optimistic by the sum of those times over the window.

For the viewer: the start gate opens when the schedule says every fragment will
be in the page before the playhead needs it. A schedule that omits the page's
own work opens the gate early by that work; on a device where parsing or
appending is slow (a TV browser, a busy laptop) that is a stop after the start.
The fix uses only the page's own measurements; nothing is assumed for a device.

## What changes

1. The browser processing of one fragment is measured from the page's samples
   (design §2): the time during which the page parsed or appended it after its
   load ended, that is the length of the union of its parse span and the
   execute spans of its appends (`executeMs`, added by the paired server
   change, ending at the append sample's age), so an append during the parse
   and parallel appends to two SourceBuffers count once. A track's rate is the sum of these times over the sum of the
   fragments' bytes, over the samples the page reports (its last 30 s).
2. The schedule charges each fragment `bytes × rate` after its delivery and lets
   the track's next transfer start only when that processing ends; the shared
   link stays free for the other track meanwhile. The suffix after the near
   window gets the same bound per track (design §3.3).
3. Without a usable sample the term is not charged and the result says
   `browser-processing-unmeasured` for that track. The gate is not held for it:
   a sample exists only after the page has buffered a fragment.
4. `firstRequiredStages` reports the processing and the completion of the first
   required fragment when measured.
5. The readiness log line states each track's processing rate and sample count.
6. `services/viewer/Viewer.js` accepts and keeps `executeMs` on append samples.

## Out of scope

- Init segment loading and appending (#259): the init is appended once per
  output before any media sample exists, so no media fragment the schedule
  plans waits for it after a rate is measured.
- Request round-trip time per fragment, playlist requests (#259), readiness
  observation and polling (#261), first frame (#262).
- Browser memory (`maxBufferLength`): production stays scheduled independently
  of browser storage, as today.
- The displayed ETA: the page shows none (`WaitingModel.update`, `etaSeconds =
  null`); this change touches the proxy's gate and its diagnostics only.

## Can it be undone

Yes: one proxy change and one server telemetry field; no stored data.
