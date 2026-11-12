# Design: browser fragment processing in the readiness schedule

Line numbers are at proxy `origin/main` `0fddd3a3`; re-locate by name.
hls.js references are to the npm package `hls.js@1.7.4` (`src/`), the version in
server `package-lock.json`.

## 1. Facts

1. The page reports, per net report, two sample sets per track (`video`,
   `audio`) and kind (`init`, `media`), each kept 30 s
   (`server/public/domain/append-service.js`, `fragment-service.js`,
   `SAMPLE_WINDOW_MS = 30_000`). Ages are milliseconds before the report's own
   snapshot moment (`appendSnapshotAt`), on the page's monotonic clock.
   1. `fragmentService[track][kind].samples[]`: `bytes` (the loaded payload),
      `fragmentId`, `fragmentSequence`, `partIndex`, and `eventAgesMs` with
      `loadEnd` (hls.js `frag.stats.loading.end`), `parseStart`, `parseEnd`
      (`frag.stats.parsing`), `bufferingStart`, `bufferingEnd`
      (`frag.stats.buffering`, set at `FRAG_BUFFERED`); an absent event is
      `null`. The sample is recorded at `FRAG_PARSED`; `bufferingEnd` is
      filled in at `FRAG_BUFFERED` of the same `fragmentId`.
   2. `appendService[buffer][kind].samples[]`: one per `BUFFER_APPENDED`, with
      `bytes`, `elapsedMs` (from `BUFFER_APPENDING` to `BUFFER_APPENDED`),
      `ageMs`, `fragmentId`. `buffer` is the SourceBuffer the append went to
      (`trackOf(data)`: `audio` when `data.type` is `audio`, else `video`). A
      muxed main fragment appends to both buffers under one `fragmentId`.
   3. `fragmentId` is `[parent or frag.type, cc, level, sn, start, part index]`
      in both sets; for a fragment of this project's playlists `parent` and
      `frag.type` are both `main` or both `audio`, so the ids are equal.
2. `elapsedMs` of an append includes waiting, not only work. hls.js holds a
   soundtrack append while the picture buffer is empty or behind
   (`buffer-controller.ts`, `blockAudio(partOrFrag)` in `onBufferAppending`),
   and every append waits in its SourceBuffer's operation queue. The work
   itself is `chunkMeta.buffering[type].executeStart` → `executeEnd`
   (`buffer-controller.ts`, `execute` and `onComplete`), available on the
   `BUFFER_APPENDED` event as `data.chunkMeta`. The paired server change
   reports it as `executeMs`.
3. `frag.stats.parsing.start` can be earlier than `loading.end` when hls.js
   streams a fragment into the transmuxer while it loads; time before the load
   ends is transfer, which the schedule already charges on the link.
4. A fragment's appends can execute before its parse ends. hls.js triggers
   `BUFFER_APPENDING` from `_handleTransmuxComplete` (`stream-controller.ts`,
   `bufferFragmentData`), and the operation's `executeStart` is set as soon as
   the buffer's queue reaches it (`buffer-controller.ts`, `execute`);
   `frag.stats.parsing.end` is set later, in `_handleTransmuxerFlush`
   (`base-stream-controller.ts`), on the transmuxer's separate `flush` message
   (`transmuxer-worker.ts`). So parse and append spans of one fragment can
   overlap, and their sum can exceed the time the page actually worked.
5. An append sample's `ageMs` is the age of its `executeEnd`: the page records
   the sample in its `BUFFER_APPENDED` handler, which hls.js calls
   synchronously in `onComplete` right after setting `executeEnd`
   (`buffer-controller.ts`), and both sample sets share one snapshot moment
   (`server/public/domain/net-report.js`, `appendSnapshotNow`). So an append's
   execute span is the age interval `[ageMs, ageMs + executeMs]`, on the same
   clock as the fragment's `eventAgesMs`. No new page field is needed.
6. A stream controller loads its next fragment only after the previous one is
   buffered (proposal, "Why", 2). The two stream controllers (main and audio)
   are independent; they share the network.
7. `predictPlaybackReadiness` today: `completion.at = deliveryAt + appendSeconds`
   with `appendSeconds = 0` (no caller supplies it), `scheduleTransfers` sets
   `trackFreeAt = deliveryAt`, `scheduleTail` bounds the suffix by
   `max(latestTrackFinish, link.finish(outputBits, deliveryStart))`.

## 2. Measured processing of one fragment and of a track

New pure module `services/viewer/browser-processing.js`:

```js
/**
 * @param {object | null} fragments - `fragmentService[track]` of the output's own track.
 * @param {object | null} appends - the whole `appendService` (`{ video, audio }`).
 * @returns {{ secondsPerByte: number, fragments: number, bytes: number, seconds: number }
 *   | { reason: "browser-processing-unmeasured" }}
 */
export function browserProcessingOf(fragments, appends)
```

For each sample `f` of `fragments.media.samples`, it is used only when all of
these hold; otherwise it is skipped (no partial value):

1. `f.bytes` is a positive safe integer; `f.fragmentId` is a non-empty string.
2. `f.eventAgesMs.loadEnd`, `parseStart`, `parseEnd` and `bufferingEnd` are
   finite and ≥ 0 (the fragment is fully buffered, so all its appends are done).
3. Every media append sample, in either buffer, with the same `fragmentId`
   has a finite `ageMs` ≥ 0. Of these, the samples of this load are those
   with `ageMs ≥ age.bufferingEnd`: hls.js records every append of a load
   (`BUFFER_APPENDED`) before `onUnblocked` sets `frag.stats.buffering.end`
   after the append queues drain (`buffer-controller.ts`), so an append with
   a smaller age ended after this load was buffered and belongs to a later
   load of the same fragment, whose `FRAG_PARSED` sample may not be recorded
   yet. Such samples are left out, whatever their other fields.
4. At least one append sample of this load exists, and every one has a finite
   `executeMs` ≥ 0.

Its processing is the time during which the page was parsing or appending it
after its load ended: the length of the union of these age intervals, in ms
(ages grow into the past, so a later event has a smaller age; an interval is
written `[later, earlier]` and is empty when `later ≥ earlier`):

```
load    = age.loadEnd
parse   = [age.parseEnd, min(age.parseStart, load)]
appends = for each append sample a of this load (3), in either buffer:
          [a.ageMs, min(a.ageMs + a.executeMs, load)]
work(f) = length of the union of parse and appends
```

The union counts each moment once (facts 4 and 5): an append that executes
while the parse is still running, and appends to the picture and the sound
buffer that execute at the same time (separate SourceBuffers work in
parallel), are not added twice. A gap between intervals, such as an append's
wait in its buffer's queue or behind the picture (fact 2), is not counted.
Every interval is clipped to start no earlier than the end of the load (fact
3), and every append interval ends no later than `age.bufferingEnd` (3), so
`work(f)` never exceeds `age.loadEnd - age.bufferingEnd`.

Cost: the page chooses how many samples it reports, and the forecast runs on
every progress request, so the append samples are indexed by `fragmentId` once
per call and each fragment reads only its own; the work is linear in the
number of samples plus the sorting of each fragment's own intervals, never
fragments × appends.

The track's result is `seconds = Σ work / 1000`, `bytes = Σ f.bytes`,
`secondsPerByte = seconds / bytes`, `fragments` = number of used samples. With
no used sample: `{ reason: "browser-processing-unmeasured" }`. When several
media samples in `fragments` share one `fragmentId` (a fragment loaded again),
none of them is used: the append samples join by `fragmentId` only, so which
appends belong to which load is not shown, and charging all of them to each
load would count the same append twice.

This is total work over total bytes, the same aggregation the encoder rate uses
(`summarizeRate`, work over working time), so one large or one small fragment
does not weigh more than its bytes.

## 3. Schedule

### 3.1 Inputs

`ViewerRequests.#playbackReadinessFor` adds to each track
`browserAppends`: the whole `viewerReading.appendService` under the same
condition that today guards `appendService` (valid buffer capture and
`appendSessionId === session.id`), else `null`. `track.fragmentService` stays as
today. The unused input `track.appendSeconds` is removed from
`predictPlaybackReadiness` (no caller sets it; the test reference model in
`test/no-torrent/support/whole-film-forecast.js` keeps its own copy, which
reads 0 because no test sets it).

### 3.2 Near window

In `predictPlaybackReadiness`, each `trackState` entry gets
`browser = browserProcessingOf(track.fragmentService, track.browserAppends)`.

Each transfer job gets `browserSeconds = sizeBits / 8 × browser.secondsPerByte`
when measured, else 0. In `scheduleTransfers`:

```
deliveryAt   = link.finish(sizeBits, max(linkFreeAt, max(readyAt, trackFreeAt[track])))
completionAt = deliveryAt + browserSeconds
linkFreeAt   = deliveryAt                 // the link is free during processing
trackFreeAt[track] = completionAt         // hls.js asks for the next fragment after buffering
```

`completions[].at = completionAt` (replacing `deliveryAt + appendSeconds`);
the continuity constraint on delivery is unchanged in form.

### 3.3 Suffix

In `scheduleTail`, for each track with a measured rate and output bits
`bits_t = bitsPerMediaSecond × (end - deliveryStart)` (the same per-track term
summed into `outputBits` today), the track cannot finish before

```
trackDone_t = link.finish(bits_t, deliveryStart') + bits_t / 8 × secondsPerByte_t
```

where `deliveryStart'` is the same start the aggregate link term uses. A track's
transfers and its processing alternate (fact 6), so its own transfer time at
the full link rate plus its own processing time is a lower bound on its
completion. `completedAt = max(latestTrackFinish, deliveryAt, max_t trackDone_t)`.

### 3.4 First required stages

For the first required fragment of each track: `browserProcessingSeconds` =
its `browserSeconds` and `completionSeconds = deliveryCompleteSeconds +
browserProcessingSeconds` when the track is measured; otherwise
`browserProcessingSeconds: null`, `browserProcessingReason:
"browser-processing-unmeasured"`, `completionSeconds: null`. The fields
`appendSeconds` and `appendReason` are replaced by these two;
`browserLoadToParseSeconds`, `appendRequestToAckSeconds` and their reasons stay
null with their reasons (those separate distributions are still not used), and
`observedBrowserWork` stays as evidence.

### 3.5 Result and log

The result of a computed forecast carries `browserProcessing: [{ track,
secondsPerByte, fragments }` or `{ track, reason }]` in track order. The
readiness log line (`playback readiness <session> …`) prints it as part of the
forecast. The answer to the page carries it too, as `playbackReadiness.browserProcessing`
(`ViewerRequests` removes only `firstRequiredStages` before answering); the page
does not read it. Nothing else in the answer changes.

## 4. Validation of `executeMs` (proxy entry)

`services/viewer/Viewer.js` `appendServiceSnapshot` accepts on each sample an
optional `executeMs` that is `undefined`, `null`, or finite and ≥ 0, and keeps
it (`executeMs ?? null`). Any other value makes the snapshot invalid, as for the
other fields today. A page without the server change sends no `executeMs`; its
samples are then unusable (§2, 3) and the term stays unmeasured.

## 5. Docs and changeset

1. `docs/playback-start-forecast.md`, "Current forecast": replace "client
   receive/append time is not separately measured" with the measured
   processing and the per-track request order; `docs/first-frame-wait-model.md`
   section 7 items 2, 4 and 5 (`appendSeconds` "ViewerRequests supplies no
   appendSeconds") changed to the new term; `docs/layout.md` lists
   `services/viewer/browser-processing.js` with its owner.
2. `.changeset/<name>.md`: `"@torrent-tv/proxy": patch`, one sentence.

## 6. Release order

Proxy first (it tolerates pages without `executeMs`), then the add-on, then the
server (meta AGENTS.md, "Process" rule 3). Until the server ships, the term is
unmeasured everywhere and behaviour equals today's.
