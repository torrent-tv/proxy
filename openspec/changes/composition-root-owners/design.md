# Design: Give the logic in the proxy composition root its owners

Normative. Names, signatures, return shapes, log text and the order of awaits
are as written here. Tests are written from this document before the code
exists. Line numbers refer to proxy `origin/main` at `3473cf3`.

Read before coding: `server.js:513-1023` (maps, pass, media read parameters),
`server.js:1046-1203` (`wireOutputs` call, encoder input), `server.js:1350-1562`
(start order, source preparation), `services/server/wire-outputs.js:184-260,
960-1000, 1219-1253`, `services/torrent/PlaybackProjection.js:337-552`,
`services/viewer/DownloadMaps.js:30-170, 286-300`,
`services/media/direct-segment-input.js`, `services/media/SegmentInputs.js`,
`services/media/ContainerOrchestrator.js:121-372`, `biome.json`.

## Rules for every step

1. **Move verbatim first.** Each step first moves the code as it is, replacing
   every free variable of the `startProxyServer` closure with a named port; it
   adds the tests from this document; only then does it remove duplicates.
2. **Ports, not imports.** A module imports only what its biome rule allows
   (`services/media/*.js`: its own directory and `utils/`;
   `services/torrent/*.js`: its own directory, `demand/`, `utils/`,
   `storage/keep.js`, `viewer/PriorityMap.js`; `services/encode/*.js`: its own
   directory; `services/server/*.js`: `encode/output/index.js`,
   `storage/keep.js`, `utils/`). Everything else is a constructor port.
   `server.js` is not under a rule and imports the modules to pass them in.
3. **Same awaits, same order.** Every `await` of the moved code stays, in the
   same order, and every `map.isCurrent()` check that followed an await
   follows the same await. No check is added where there was none.
4. **Same identities.** An object that a cache compares by `===` (track list,
   timeline, choices array, joined ranges, the answer of `inspect`) is handed
   on as the same object, never copied or rebuilt.
5. **Non-result answers pass through.** Where the moved code returned an
   answer of `ContainerOrchestrator#inspect` as it was, the owner returns the
   same object.
6. **Tests** live in `test/no-torrent/`, use `node:test` and
   `node:assert/strict`, construct no torrent client and name no entry point
   (`scripts/check-tests-start-no-torrent.mjs`).

### Shared shapes

```js
/** A track as the container states it (`ContainerTrack` or a plain object). */
// { type: "video" | "audio" | "subtitle" | "other", trackNumber: number,
//   declaredIndex?: number, isEnabled?: boolean }

/** What one output reads of one file. */
// Choice = { type: "video" | "audio", index: number | null, mode: "copy" | "transcode" }
// `trackChoicesOf` gives the picture `index: 0`; the encoder gives it `index: null`.

/** What `ContainerOrchestrator#inspect(params, statement)` answers. */
// Answer = { kind: "result", value, requestId }
//        | { kind: "needs-ranges", ranges: Array<[number, number]>, requestId, passive?: true }
//        | { kind: "needs-memory", bytes: number, requestId }
//        | { kind: "terminal", reason: string, requestId, message?: string }

/** `Timeline#sourceInterval(fromIndex, toIndex, shift)`. */
// SourceInterval = { from: number, to: number, endsWithSource?: true }
```

---

## 1. One rule for what a segment reads (#ttv-271)

**Module:** `services/media/segment-reading.js` (rule `services/media/*.js`).
Imports only `./tracks/ContainerTrack.js`. Pure functions, no state.

```js
export function trackFor(trackList, choice)            // → Track | null
export function selectTracks(trackList, choices)       // → { wanted: Track[], modes: Map<Track, string> } | null
export function readingInterval({ wanted, modes }, sourceInterval)
                                                       // → { ...sourceInterval, trackIds: number[], modes: Record<number, string> }
export function segmentReading(trackList, choices, sourceInterval)
                                                       // → { wanted, modes, interval } | null
```

- `trackFor`: `choice.type === "video"` → `ContainerTrack.firstUsable(trackList,
  "video")` (the index is ignored); any other type →
  `trackList.filter(track => track.type === choice.type)[choice.index] ?? null`.
- `selectTracks`: `null` when `trackFor` is `null` for any choice. Otherwise
  `wanted` holds the tracks in choice order and `modes.get(track) ===
  choice.mode`.
- `readingInterval`: a new object whose keys are, in this order, the keys of
  `sourceInterval`, then `trackIds` (`wanted.map(track => track.trackNumber)`),
  then `modes` (`Object.fromEntries(wanted.map(track => [track.trackNumber,
  modes.get(track)]))`). The key order matters: `JSON.stringify` of it is the
  `rangesKey`.
- `segmentReading`: `selectTracks`, then `readingInterval`; `null` when the
  selection is `null`.

**The two call-site differences, decided.**

1. *declaredIndex against the filtered index.* Both copies select a soundtrack
   by its position among the file's tracks of that type (`server.js:562`,
   `server.js:1115`). Neither selects by `declaredIndex`. The encoder then
   STATES `track.declaredIndex ?? choices.find(choice => choice.type ===
   track.type)?.index ?? 0` as the ffmpeg selection index of an original input
   (`server.js:1137-1138`); that is not selection and stays, verbatim, in
   `EncodeInputResolution` (§5). The shared functions return the tracks
   themselves, so `declaredIndex` stays readable. The picture's choice index
   (`0` from `trackChoicesOf`, `null` from the encoder) is ignored by
   `trackFor` and both give `0` in the encoder's `?? 0`.
2. *`terminal` against `null`.* The shared functions answer `null` for an
   absent track and each call site keeps its own answer: the pass records
   P4.1 outcome `segment-reading-unavailable` and calls
   `projection.setUnreadable` (§3); the encoder returns `{ kind: "terminal",
   reason: "selected-track-is-absent" }` (§5). The encoder decides this BEFORE
   it reads `media-info`, which is why selection (`selectTracks`) and the
   interval (`readingInterval`) are two functions.

Not merged: source preparation finds an embedded subtitle by `declaredIndex`
(`server.js:1471`), which is the subtitle menu's numbering, not this rule.

**Call sites.** In #271 itself both copies inside `server.js` are replaced by
calls to these functions (`server.js` imports the module). After #273 and
#275 the functions reach their call sites as ports, because
`services/torrent/*.js` and `services/encode/*.js` may not import the media
layer: `PlaybackResolution` gets `segmentReading`, `EncodeInputResolution` gets
`selectTracks`, `readingInterval` and `trackFor`. `stretchCopied`'s soundtrack
lookup (`server.js:1168`) becomes `trackFor(tracks, { type: "audio", index:
sound.trackIndex })`.

**Test:** `test/no-torrent/segment-reading.test.js`. Plain track objects, e.g.
`{ type: "video", trackNumber: 1, declaredIndex: 0, isEnabled: false }`,
`{ type: "video", trackNumber: 2, declaredIndex: 1 }`,
`{ type: "audio", trackNumber: 3, declaredIndex: 0 }`,
`{ type: "audio", trackNumber: 4, declaredIndex: 1 }`.

---

## 2. One resolver of a segment's source byte ranges (#ttv-272)

**Module:** `services/media/SegmentSourceRanges.js` (rule `services/media/*.js`).
Imports `./direct-segment-input.js` and `./SegmentInputs.js`.

```js
export class SegmentSourceRanges {
  /** @param {{ orchestrator: { inspect(params, statement): Promise<Answer>,
   *                            known(sourceKey, fileIndex): object | null | undefined } }} ports */
  constructor({ orchestrator })
  keyOf(sourceKey, fileIndex, interval)                        // → string
  cached(rangesKey)                                            // → { kind: "result", ranges, method: "source-range-cache" } | null
  async tracksOf(params, isCurrent = () => true)               // → TracksAnswer
  async shiftOf(params, isCurrent = () => true)                // → ShiftAnswer
  async navigable(params, isCurrent = () => true)              // → NavigationAnswer
  async readInput(params, { original, tracks, modes, interval }, isCurrent = () => true)  // → InputAnswer
  async resolve({ rangesKey, direct, interval, tracks, modes, intervalParams,
                  isCurrent = () => true, whenBuilt = () => {} })                        // → RangesAnswer
  forget(sourceKey)                                            // → void
}
```

`orchestrator` is `containerOrchestrator` in production; its methods are
called as methods (`orchestrator.inspect(params, statement)`).

**State.** `#ranges: Map<rangesKey, Array<[number, number]>>` — the
`segmentSourceRanges` map of `server.js:527`. Lives for the process; the
entries of a source go with `forget(sourceKey)`, which deletes every key that
starts with `` `${sourceKey}:` ``.

**Methods.**

- `keyOf` → `` `${sourceKey}:${fileIndex}:${JSON.stringify(interval)}` ``.
- `cached(rangesKey)` → the kept ranges as `{ kind: "result", ranges, method:
  "source-range-cache" }` (the same array object), or `null`.
- `tracksOf`: `answer = await orchestrator.inspect(params, "tracks")`; then
  `!isCurrent()` → `{ kind: "stale" }`; `answer.kind !== "result"` → `answer`
  (same object); `container = orchestrator.known(params.sourceKey,
  params.fileIndex)`, read after the await; neither
  `typeof container?.readSourceRanges === "function"` nor
  `typeof container?.readPacketIndex === "function"` → `{ kind: "needs-index",
  reason: "packet-index-not-yet-available" }`; else `{ kind: "result",
  trackList: answer.value, container }`. `trackList` IS `answer.value`.
- `shiftOf`: `answer = await orchestrator.inspect(params, "media-info")`;
  `!isCurrent()` → `{ kind: "stale" }`; non-result → `answer`; else
  `{ kind: "result", shift: Number(answer.value?.startTimeSeconds) || 0 }`.
- `navigable`: `answer = await orchestrator.inspect(params,
  "source-navigation")`; `!isCurrent()` → `{ kind: "stale" }`; non-result →
  `answer`; else `{ kind: "result", value: answer.value === true }`.
- `readInput`: `answer = await orchestrator.inspect(params, original ?
  "source-ranges" : "packets")`; `!isCurrent()` → `{ kind: "stale", step:
  "packets" }`; non-result → `{ kind: answer.kind, step: "packets", answer }`;
  `input = original ? answer.value : new SegmentInputs({ index: answer.value,
  tracks }).forInterval({ ...interval, mode: track => modes.get(track) })`;
  `input.kind !== "result"` → `{ kind: input.kind, step: "input", answer:
  input }`; else `{ kind: "result", method: original ? "container-source-ranges"
  : "packet-index", input }`. (A `source-ranges` result's `value` is itself a
  `{ kind: "result", ranges, … }` by `ContainerOrchestrator`'s construction, so
  the check is a no-op for the encoder, which did not make it.)
- `resolve` — one segment, the chain of `server.js:825-886`:
  1. If `direct`: `value = await directSegmentInput(direct, { interval, tracks,
     mode: track => modes.get(track) }, whenBuilt)`, a throw counting as
     `value = null`. NO `isCurrent()` check after this await (there was none).
     `value?.kind === "pending"` → `{ kind: "pending", method:
     "direct-source-index", step: "direct" }`. `value?.kind === "result"` →
     keep `value.ranges` under `rangesKey`, return `{ kind: "result", ranges:
     value.ranges, method: "direct-source-index" }`. Anything else falls
     through.
  2. `params = await intervalParams()`; `!isCurrent()` → `{ kind: "stale",
     method: "container-index-fallback", step: "params" }` (checked before
     `params`); `!params` → `{ kind: "needs-source", method:
     "container-index-fallback", step: "params" }`.
  3. `navigation = await this.navigable(params, isCurrent)`; stale → `{ kind:
     "stale", method: "container-index-fallback", step: "navigation" }`;
     non-result → `{ kind: navigation.kind, method: "container-index-fallback",
     step: "navigation", answer: navigation }`.
  4. `read = await this.readInput(params, { original: navigation.value, tracks,
     modes, interval }, isCurrent)`; non-result → the same object with
     `method: "container-index-fallback"` added (`{ ...read, method }`).
  5. Keep `read.input.ranges` under `rangesKey`; return `{ kind: "result",
     ranges: read.input.ranges, method: read.method }`.

  Errors other than those of `directSegmentInput` propagate.

`intervalParams` is a thunk so that the caller's demand vocabulary (request id,
zone owner) stays with the caller and params are made only when the fallback
is reached.

**Answers, in full.**

```js
// TracksAnswer     = { kind: "result", trackList, container } | { kind: "stale" }
//                  | { kind: "needs-index", reason: "packet-index-not-yet-available" } | Answer
// ShiftAnswer      = { kind: "result", shift: number } | { kind: "stale" } | Answer
// NavigationAnswer = { kind: "result", value: boolean } | { kind: "stale" } | Answer
// InputAnswer      = { kind: "result", method: "container-source-ranges" | "packet-index", input }
//                  | { kind: "stale", step: "packets" }
//                  | { kind: string, step: "packets" | "input", answer }
// RangesAnswer     = { kind: "result", ranges, method: "direct-source-index" | "container-source-ranges" | "packet-index" }
//                  | { kind: "pending", method: "direct-source-index", step: "direct" }
//                  | { kind: "stale" | "needs-source", method: "container-index-fallback", step: "params" }
//                  | { kind: "stale", method: "container-index-fallback", step: "navigation" | "packets" }
//                  | { kind: "needs-ranges" | "needs-memory" | "terminal" | string,
//                      method: "container-index-fallback", step: "navigation" | "packets" | "input", answer }
```

The issue's union (`result | pending | needs-ranges | needs-memory |
terminal`) is extended by three kinds the moved code already had: `stale`
(the map was replaced during an await), `needs-source` (no parameters: the
file is gone) and `needs-index` (the container names no bytes).

**Method names** are those of wait-trace P4.1 and do not change:
`direct-source-index`, `container-source-ranges`, `packet-index`,
`source-range-cache`, plus `container-index-fallback` and the pass's own
`segment-record-cache`.

**Wiring in #272.** `server.js` constructs `const sourceRanges = new
SegmentSourceRanges({ orchestrator: containerOrchestrator })` and both
closures (`resolvePlayback`, `resolveEncodeInput`) call it in place;
`segmentSourceRanges` and the `segmentSourceRanges` lines of
`onSourceForgotten` are replaced by `sourceRanges.forget(sourceKey)`.

**Test:** `test/no-torrent/segment-source-ranges.test.js`. Fakes:

```js
const tracks = [{ type: "video", trackNumber: 1, declaredIndex: 0 }, { type: "audio", trackNumber: 2, declaredIndex: 0 }];
// one array object for every "tracks" answer
const container = {
  supportsOriginalSourceRanges: async interval => true | false,
  readSourceRanges: async interval => ({ kind: "result", ranges: [[interval.from * 10, interval.to * 10]] }),
  packetTableWouldWait: () => false,
  readPacketIndex: async () => packetIndex,
};
const packetIndex = { inputFor: ({ trackId, from, to }) => ({ kind: "result", ranges: [[from * 100 + trackId, to * 100 + trackId]] }) };
const asked = [];
const orchestrator = {
  known: () => container,
  inspect: async (params, statement) => { asked.push(statement); return answers[statement]; },
};
// answers: tracks → { kind: "result", value: tracks }, "media-info" → { kind: "result", value: { startTimeSeconds: 1.5 } },
//          "source-navigation" → { kind: "result", value: false }, packets → { kind: "result", value: packetIndex },
//          "source-ranges" → { kind: "result", value: { kind: "result", ranges: [[5, 9]], from: 0, to: 4 } }
```

---

## 3. The download-map pass (#ttv-273)

**Module:** `services/torrent/PlaybackResolution.js` (rule
`services/torrent/*.js`). Imports `./PlaybackProjection.js`,
`./demand/pieces.js` (`joinedWithinPieces`), `../../utils/take-turns.js`
(`takeTurns`) and `node:perf_hooks`.

```js
export class PlaybackResolution {
  constructor({
    paramsFor,          // (request: { sourceKey, fileIndex, requestId?, packetInterval?, demand? }) => Promise<Params | null>
    sourceRanges,       // SegmentSourceRanges (keyOf, cached, tracksOf, shiftOf, navigable, resolve)
    segmentReading,     // (trackList, choices, sourceInterval) => { wanted, modes, interval } | null
    playedOutputsOf,    // (sourceKey, fileIndex) => PlayedOutput[]
    pieceLengthOf,      // (sourceKey) => number   — NaN when the torrent is not known
    noteSegmentInput,   // (sourceKey, fileIndex, outputKey, index, joined) => void   — SegmentInputTable#set
    refresh,            // (sourceKey, fileIndex) => Promise<unknown>                 — DownloadMaps#refresh
    observeWait,        // (sourceKey, event, fields) => void                          — waitTrace.source
    log,                // (line: string) => void                                      — logger.info
    warn,               // (line: string) => void                                      — logger.warn
    now = Date.now,     // the clock of the once-a-minute reading
    clock = () => performance.now(),  // pass and P4.1 timing
    turns = takeTurns,  // () => (() => Promise<void>)
  })
  async resolve(map)              // → Promise<Window[]>; map = { sourceKey, fileIndex, zones, isCurrent(), workingOut?(priority, zonesOf) }
  clear(sourceKey, fileIndex)     // → void; the file has no playback zones
  forget(sourceKey)               // → void; the source is forgotten
}
```

`Window` is what `PlaybackProjection#windows()` returns. `DownloadMaps` gets
`resolvePlayback: map => resolution.resolve(map)`.

### `playedOutputsOf` — built by `wire-outputs.js`

`wireOutputs` adds `parts.playedOutputsOf = (sourceKey, fileIndex) => …`
(`server.js:711-732` without the grid and the made rate) and imports
`trackChoicesOf` from `../viewer/segment-demands.js`. For every output of
`parts.outputs.values()`, in catalog order, with `output.file.sourceKey ===
sourceKey`:

1. `consumers = [...parts.viewers.forOutput(output).values()].filter(viewer =>
   viewer.isPresent() && !parts.outputs.supersededBy(output,
   viewer.activeVariantId ?? null))`; none → skipped.
2. `choices = trackChoicesOf(output, fileIndex)`; empty → skipped.
3. Entry:

```js
// PlayedOutput = {
//   outputKey: output.outputKey,
//   timeline: output.timeline,                              // the same object
//   choices,                                                // a new array per call
//   revision: parts.segmentStore.revisionOf(output.outputKey),
//   sizes: () => parts.segmentStore.sizesOf(output.outputKey),   // a thunk: sizesOf builds a new Map
//   encodeSpeed: parts.encodeCost.latestSpeedReadingOf(output)?.speed,
//   linkMbps,   // Math.min over consumers' finite positive viewer.linkReading()?.linkMbps, else null
//   target: parts.encodeInputs?.targetInputBytes?.(output) ?? null,
// }
```

### State it owns (process lifetime)

| State | Was | Key | Forgotten |
|---|---|---|---|
| projections | `playbackProjections` (`server.js:580`) | `` `${sourceKey}:${fileIndex}` `` → `{ projection, trackList, shift, pieceLength }` | `clear` empties one; `forget` deletes a source's |
| segment records | `segmentReadings` (`:540`) | `` `${sourceKey}:${fileIndex}:${outputKey}` `` → `Map<index, SegmentRecord>` | `forget` |
| choices keys | `choicesKeys` (`:549`) | `WeakMap<choices array, string>` | garbage |
| checked grids | `checkedGrids` (`:584`) | `WeakMap<timeline, grid \| null>` | garbage |
| made rates | `madeRates` (`:608`) | `outputKey` → `{ revision, timeline, bytesPerSecond }` | `forget` (key prefix `` `${sourceKey}:` ``) |
| pass costs | `passCosts` (`:627`) | one object | reset each report |
| tables awaited | `refreshAfterTable` (`:643`) | `WeakSet<container>` | when the table settles |

`SegmentRecord = { timeline, trackList, shift, choicesKey, sourceInterval,
reading: { wanted, modes, interval, rangesKey } | null, ranges: null | ranges,
pieceLength: NaN | number, joined: null | ranges, registered: null | ranges }`.

### `resolve(map)` — normative order

1. `fileKey = `${sourceKey}:${fileIndex}``. `map.zones.length === 0` → the
   file's projection (if any) is cleared; return `[]`.
2. `params = await paramsFor({ sourceKey, fileIndex })`; `!params ||
   !map.isCurrent()` → `[]`.
3. `tracks = await sourceRanges.tracksOf(params, () => map.isCurrent())`;
   `tracks.kind !== "result"` → `[]`.
4. `media = await sourceRanges.shiftOf(params, () => map.isCurrent())`;
   `media.kind !== "result"` → `[]`; `shift = media.shift`.
5. `pieceLength = pieceLengthOf(sourceKey)`; `passStartedAt = clock()`.
6. The projection stands unless `kept.trackList !== tracks.trackList ||
   kept.shift !== shift || !Object.is(kept.pieceLength, pieceLength)`; then
   the old one is `clear()`ed and a new `PlaybackProjection` is kept with
   those three facts.
7. For each `entry` of `playedOutputsOf(sourceKey, fileIndex)`: `grid =
   gridOf(entry.timeline)`, `null` → skipped; push `{ outputKey, grid,
   encodeSpeed, bytesPerSecond: bytesPerSecondOf(entry), linkMbps,
   readyRevision: entry.revision, ready: entry.sizes, target }` to `played`;
   `readers.set(outputKey, { records, choices: entry.choices, facts: {
   timeline: entry.timeline, trackList: tracks.trackList, shift, sourceKey,
   fileIndex } })`. One `choices` array per output per pass is shared by all
   of its segments.
8. `projection.update({ zones: map.zones, outputs: played })`; `reworked =
   projection.lastUpdate`; `resolved = 0`.
9. `navigated = await sourceRanges.navigable(params, () => map.isCurrent())`;
   `stale` → `[]`. `direct = navigated.kind === "result" && navigated.value
   === true && typeof tracks.container?.readSourceRanges === "function" ?
   tracks.container : null` (any other answer leaves `direct = null` and the
   pass goes on).
10. `waiting = new Set()` (outputs held for this pass); `turn = turns()`.
11. For each `zone` of `projection.unresolved()`:
    1. `!map.isCurrent()` → `[]`; `await turn()`; `!map.isCurrent()` → `[]`
       (no P4.1 event for these two).
    2. P4.1 `begin` (below); then, inside `try`:
    3. `reader = readers.get(zone.outputKey)`; none → `reader-missing`.
    4. `record = recordOf(reader, zone.index)`; `record.reading === null` →
       `segment-reading-unavailable` and `projection.setUnreadable(outputKey,
       index)`.
    5. `trackCount`, `trackIds`, `sourceInterval: { from, to }` are set from
       the reading.
    6. `known = record.ranges ? { ranges: record.ranges, method:
       "segment-record-cache" } : sourceRanges.cached(rangesKey)`; found →
       `convert(known.ranges, known.method)`.
    7. `waiting.has(outputKey)` → `waiting-for-output-input`.
    8. `map.workingOut?.(zone.priority, () => projection.windows())`.
    9. `answer = await sourceRanges.resolve({ rangesKey, direct, interval,
       tracks: wanted, modes, intervalParams: () => paramsFor({ sourceKey,
       fileIndex, packetInterval: interval, requestId:
       `download:${sourceKey}:${fileIndex}:${zone.outputKey}:${zone.index}`,
       demand: { ...zone.owner, leadSeconds: zone.leadSeconds } }), isCurrent:
       () => map.isCurrent(), whenBuilt: built => refreshWhenBuilt(direct,
       built, map) })`, mapped by the table below.
    10. `catch (error)`: outcome `error`, `error: error?.message ??
        String(error)`, rethrow. `finally`: P4.1 `end`.
12. `result = projection.windows()`; `notePass({ whole: reworked.whole,
    reworked: reworked.segments, resolved, windows: result.length, ms: clock()
    - passStartedAt })`; return `result`.

`convert(ranges, method)`: if `record.ranges !== ranges ||
record.pieceLength !== pieceLength`, set both and `record.joined =
joinedWithinPieces(ranges, pieceLength)`; `joined = record.joined`; set
`method`, `rangeCount = joined.length`, `rangeBytes = Σ (end - start + 1)`;
if `record.registered !== joined` → `noteSegmentInput(sourceKey, fileIndex,
outputKey, index, joined)` and `record.registered = joined`;
`projection.setRanges(outputKey, index, joined)`; outcome `resolved`;
`resolved += 1`.

| `answer` | P4.1 `method` | P4.1 `outcome` | held in `waiting` | pass |
|---|---|---|---|---|
| `result` | `answer.method` | `resolved` (via `convert`) | | goes on |
| `pending` | `direct-source-index` | `source-index-pending` | yes | goes on |
| `stale` (any step) | `container-index-fallback` | `map-replaced` | | returns `[]` |
| `needs-source` | `container-index-fallback` | `source-file-unavailable` | | goes on |
| step `navigation` | `container-index-fallback` | `source-navigation-${kind}` | `needs-ranges`, `needs-memory` | goes on |
| step `packets` | `container-index-fallback` | `source-packets-${kind}` | `needs-memory` | goes on |
| step `input` | `container-index-fallback` | `segment-input-${kind}` | | goes on |

`recordOf(reader, index)`: `choicesKey` from the `WeakMap` by the choices
array (`choices.map(choice => `${choice.type}/${choice.index}/${choice.mode}`)
.join(",")`); a kept record is returned when `timeline`, `trackList`, `shift`
and `choicesKey` are all `===`; otherwise `sourceInterval =
timeline.sourceInterval(index, index, shift)`, `reading =
segmentReading(trackList, choices, sourceInterval)` plus `rangesKey =
sourceRanges.keyOf(sourceKey, fileIndex, reading.interval)`, and a new
record with `ranges: null, pieceLength: NaN, joined: null, registered: null`
replaces the old one.

`gridOf(timeline)`: not an object → `null`; cached by timeline; `grid =
timeline.published ?? timeline.boundaries`; not an array → cached `null`; a
pair that is not finite and increasing → `throw new Error("An output segment
needs a valid interval.")` (not cached).

`bytesPerSecondOf(entry)`: the kept rate when `revision` and `timeline` are
`===`; else over `entry.sizes()`: `span = timeline.publishedStartOf(index + 1)
- timeline.publishedStartOf(index)`, summed where `span > 0`; `seconds > 0 ?
bytes / seconds : null`.

`refreshWhenBuilt(container, built, { sourceKey, fileIndex })`: once per
container while its table is built — `void built.then(() => { forget the
container; return refresh(sourceKey, fileIndex); }).catch(error =>
warn(`download map after a packet table: ${error?.message ?? error}`))`.

### Wait-trace P4.1 (unchanged)

```js
observeWait(sourceKey, "process", { process: "P4.1", phase: "begin", resolutionId,
  sourceId: `${sourceKey}:${fileIndex}`, fileIndex, outputKey: zone.outputKey,
  segment: zone.index, priority: zone.priority, deadlineAt: zone.deadlineAt });
observeWait(sourceKey, "process", { process: "P4.1", phase: "end", resolutionId,
  sourceId, fileIndex, outputKey, segment, priority,
  startedAt, endedAt, durationMs: endedAt - startedAt,
  outcome, method, trackCount, rangeCount, rangeBytes, trackIds?, sourceInterval?, error? });
// resolutionId = `${fileIndex}:${zone.outputKey}:${zone.index}:${passStartedAt.toFixed(3)}`
// the resolution object starts as { outcome: "unresolved", method: null, trackCount: null, rangeCount: null, rangeBytes: null }
```

### `download map passes` (unchanged)

`notePass` counts every pass; when `now() - since >= 60_000` it calls `log`
with exactly

```
`download map passes in ${((now - since) / 1000).toFixed(1)}s: ${passes} map(s), ` +
`${whole} worked out whole, ${reworked} segment(s) worked out again, ` +
`${resolved} segment(s) had their ranges worked out, ${windows} window(s) told; ` +
`${Math.round(ms)}ms from start to result in all, longest ${Math.round(maxMs)}ms`
```

and resets every counter with `since = now`. `since` starts at `now()` in the
constructor.

### What stays in `server.js` and how it is wired

```js
const resolution = new PlaybackResolution({
  paramsFor: request => mediaParams.paramsFor(request),   // before #274: request => containerOver(request)
  sourceRanges, segmentReading,
  playedOutputsOf: outputParts.playedOutputsOf,           // before #276: (s, f) => outputParts.playedOutputsOf(s, f)
  pieceLengthOf: sourceKey => Number(torrentPool.knownTorrent(sourceKey)?.pieceLength),
  noteSegmentInput: (...args) => segmentInputs.set(...args),
  refresh: (sourceKey, fileIndex) => downloadMaps.refresh(sourceKey, fileIndex),
  observeWait: (sourceKey, event, fields) => waitTrace.source(sourceKey, event, fields),
  log: line => logger.info(line), warn: line => logger.warn(line),
});
```

`setPriorityMap`'s `playbackProjections.get(...)?.clear()` becomes
`resolution.clear(sourceKey, fileIndex)`; `onSourceForgotten` calls
`resolution.forget(sourceKey)` and `sourceRanges.forget(sourceKey)` where the
four prefix loops were. `segmentInputs` (`SegmentInputTable`) stays in
`server.js`: the pass writes it and the forecast reads it through
`sourceInputsFor`.

### Tests

- `test/no-torrent/playback-resolution.test.js` — characterisation, with a
  real `SegmentSourceRanges` over a fake orchestrator (§2 shapes), the real
  `segmentReading`, a real `Timeline` (`new Timeline({ boundaries: [0, 4, 8,
  12], cutGrid: "keyframe" })`) and these fakes:

  ```js
  const map = { sourceKey: "src", fileIndex: 0, zones: [{ from: 0, to: 12, priority: 100, urgent: true, deadlineAt: 10_000 }],
    isCurrent: () => current, workingOut: (priority, zonesOf) => stated.push(priority) };
  const played = [{ outputKey: "src:out-a", timeline, choices: [{ type: "video", index: 0, mode: "copy" }],
    revision: 0, sizes: () => new Map(), encodeSpeed: undefined, linkMbps: null, target: null }];
  const ports = { paramsFor: async request => ({ ...request }), playedOutputsOf: () => played,
    pieceLengthOf: () => 16, noteSegmentInput: (...args) => noted.push(args), refresh: async (...args) => refreshed.push(args),
    observeWait: (sourceKey, event, fields) => events.push(fields), log: line => lines.push(line), warn: line => warnings.push(line),
    now: () => wall, clock: () => tick, turns: () => async () => {} };
  ```

  Covers: direct index, fallback by `source-ranges` and by `packets`, pending
  → the output held in `waiting` and one `refresh` when the table settles,
  `needs-memory`, map replaced mid-pass → `[]` with `map-replaced`, cache hits
  (`segment-record-cache` after `clear`, `source-range-cache` for a second
  output of the same interval), repeated AVI zones (two segments with equal
  ranges each noted), the minute line, identity invariants.
- `test/no-torrent/played-outputs-of.test.js` — `managerWithOwnStore()`
  (`test/no-torrent/helpers/manager.js`), outputs set into `manager.outputs`,
  viewers through `manager.viewers.join(output, id)`.
- `test/no-torrent/playback-resolution-equivalence.test.js` with
  `test/no-torrent/support/resolve-playback-before-270.js` — TEMPORARY.
  The support file is `server.js:526-904` at `origin/main`, copied verbatim
  into `export function resolvePlaybackBefore270({ containerOver,
  containerOrchestrator, outputParts, torrentPool, waitTrace, segmentInputs,
  downloadMaps, logger })` returning `{ resolvePlayback }`. Fixtures are
  generated with `ffmpeg-static` from `lavfi` into a temporary directory, as
  `avi-reordered-local.test.js` does: an AVI (`mpeg4` + `libmp3lame`, with
  `idx1`), an MKV and an MP4 (`libx264` + `aac`), 12 s, a keyframe every 2 s.
  Each side gets its own `new ContainerOrchestrator()`, params whose
  `readRange` reads the file's buffer, a real `IndexMemory`, a picture output
  and a soundtrack output with real `Timeline`s, and the same sequence of maps
  (whole film, then a seek to 8 s). Every pass must return deep-equal windows
  and the same `(outputKey, index, joined)` notes. Deleted once #273 is merged
  (task 3.12).

---

## 4. Media read parameters (#ttv-274)

**Module:** `services/server/MediaReadParams.js` (rule `services/server/*.js`).
Imports nothing. Its state lives as long as a request's `AbortSignal`.

```js
export class MediaReadParams {
  constructor({
    heldFile,        // (sourceKey, fileIndex) => HeldFile | null
    packetMemory,    // (sourceKey, fileIndex) => object               — IndexMemory#forFile
    readProbe,       // (request) => Promise<unknown>                  — ProbeRequests#read
    probePackets,    // ({ url: string, statement, signal, onRecord }) => Promise<unknown>   — media/probe-packets.js
    baseUrl,         // () => string                                   — the proxy's own loopback origin
    observeWait,     // (sourceKey, event, fields) => void
    reads,           // { revision(sourceKey, fileIndex), memoryRevision(), record(params, statement, result, storage, memory) → boolean }
    maps,            // { epoch(sourceKey, fileIndex) → number, wantsInterval(sourceKey, fileIndex, interval) → boolean,
                     //   metadata(entry) → Promise, withdrawMetadata(sourceKey, fileIndex, statement) → Promise,
                     //   refresh(sourceKey, fileIndex) → Promise }
    learnKeyframes,  // (params, { times, tolerance, format }) => void   — KeyframeTables#learn
    formatOf,        // (sourceKey, fileIndex) => string   — known container's formatName ?? "unrecognised"
    warn,            // (line: string) => void
  })
  async paramsFor({ sourceKey, fileIndex, requestId, packetInterval, demand, readPriority, signal })  // → Promise<Params | null>
}
// HeldFile = { length: number, name: string, offset: number, portionBytes: number | undefined,
//              readHeld(start, end): Promise<Buffer | null>, noteVideo(hasVideo: boolean): void }
```

`paramsFor` reads only those seven fields of its argument (a whole map, a
preparation work item or `{ …, tailBytes }` may be passed; the rest is
ignored, as now). It stays `async`.

**State.** `WeakMap<AbortSignal, Map<fileKey, { statements: Set<string>, abort()
}>>` — `encodeMetadataRequests` of `server.js:924`. An entry exists only for a
call with `readPriority?.requestId` and `signal`; it is removed when its
signal aborts.

**`paramsFor`, normative.**

1. `file = heldFile(sourceKey, fileIndex)`; `null` → `null`.
2. Tracker, only when `readPriority?.requestId && signal`: one per signal and
   `` `${sourceKey}:${fileIndex}` ``, shared by every later call with that
   signal and file. Its `abort` calls `maps.withdrawMetadata(sourceKey,
   fileIndex, statement).catch(error => warn(`encode input demand withdrawal
   failed: ${error.message}`))` for each statement held, clears them, removes
   the file entry and, when that empties it, the signal entry. A new tracker
   on an aborted signal aborts at once; otherwise it is registered with
   `signal.addEventListener("abort", abort, { once: true })`.
3. Returns a new object:

```js
{ sourceKey, fileIndex, requestId, signal, packetInterval, readPriority,
  packetMemory: packetMemory(sourceKey, fileIndex),
  downloadInterval: demand ? { from: demand.from, to: demand.to } : null,
  readRange: (start, end) => file.readHeld(start, Math.min(end, file.length - 1)),
  fileSize: file.length,
  probe: (statement, onRecord) => readProbe({ sourceKey, fileIndex, statement: `ffprobe:${statement}`,
    probe: ({ requestId, signal }) => probePackets({ url: url.toString(), statement, signal, onRecord }) }),
    // url = new URL("/media", baseUrl()) with searchParams sourceKey, fileIndex (String), readId = requestId, set in that order;
    // probePackets receives url.toString(), a STRING, as server.js:972-977 passes it — never the URL object
  label: file.name,
  fileOffset: file.offset,
  onObserved: fields => …,      // two observeWait events, below
  onTracks: tracks => file.noteVideo(tracks.some(track => track.type === "video")),
  onReadStart: () => ({ storage: reads.revision(sourceKey, fileIndex), memory: reads.memoryRevision(),
    demand: maps.epoch(sourceKey, fileIndex) }),
  onReadResult: async (statement, result, revision) => …,   // below
  portionBytes: file.portionBytes }
```

`onObserved(fields)`: `process = fields.statement === "keyframes" ? "P5" :
String(fields.statement).startsWith("ffprobe:") ? "X1" : "P2"`; `details = {
process, fileIndex, requestId, statement, cached, result, reason, ranges,
queuedMs, readMs }` (from `fields`); `observeWait(sourceKey, "process", {
...details, phase: "begin", at: fields.askedAt })`, then `observeWait(sourceKey,
"process", { ...details, phase: "end", at: fields.endedAt, startedAt:
fields.askedAt, endedAt: fields.endedAt })`.

`onReadResult(statement, result, revision)`, in this order:

1. `revision.demand !== maps.epoch(sourceKey, fileIndex)` → return.
2. `demand && !maps.wantsInterval(sourceKey, fileIndex, demand)` → return.
3. `statement === "keyframes" && result.kind === "result"` →
   `learnKeyframes(params, { times: result.value?.times ?? null, tolerance:
   result.value?.tolerance ?? 0, format: formatOf(sourceKey, fileIndex) })`.
4. `finished = reads.record(params, statement, result, revision.storage,
   revision.memory)`.
5. `statement === "chapters" && result.passive` → `await
   maps.withdrawMetadata(sourceKey, fileIndex, "chapters")` and no metadata.
   Otherwise `metadataStatement = requestId ? `${statement}:${requestId}` :
   statement`; with a tracker, `needs-ranges` adds it and any other kind
   deletes it; then `await maps.metadata({ sourceKey, fileIndex, statement:
   metadataStatement, result, …chapters, …demand, …readPriority, …owner })`
   with exactly the spreads of `server.js:1006-1013`: chapters → `{ priority:
   1, urgent: false, deadlineAt: null }`; demand → `{ priority:
   demand.priority, urgent: demand.urgent, deadlineAt: demand.deadlineAt,
   interval: demand, leadSeconds: demand.leadSeconds ?? 0 }`;
   `readPriority?.requestId` → `{ priority: readPriority.rank, urgent:
   readPriority.urgent === true, deadlineAt:
   Number.isFinite(readPriority.deadlineAt) ? readPriority.deadlineAt :
   Number.POSITIVE_INFINITY, scope: "preparation" }`; neither demand nor
   `readPriority?.requestId` → `{ owner: "file" }`.
6. `finished && result.kind === "result"` → `void maps.refresh(sourceKey,
   fileIndex).catch(error => warn(`download map source=${sourceKey}
   file=${fileIndex} metadata refresh failed: ${error?.message ?? error}`))`.

**Wiring.** `server.js` constructs `const mediaParams = new
MediaReadParams({…})` where `containerOver` was and replaces every
`containerOver(x)` with `mediaParams.paramsFor(x)`:

```js
heldFile: (sourceKey, fileIndex) => {
  if (!sourceRegistry.get(sourceKey)) return null;
  const torrent = torrentPool.knownTorrent(sourceKey);
  const file = torrent?.files?.[fileIndex];
  if (!file || !(file.length > 0)) return null;
  return { length: file.length, name: String(file.name ?? ""), offset: file.offset,
    portionBytes: Number(torrent.pieceLength) > 0 ? Number(torrent.pieceLength) : undefined,
    readHeld: (start, end) => torrentPool.readHeldOf(torrent, fileIndex, start, end),
    noteVideo: hasVideo => contentsOf(torrent).noteVideo(fileIndex, hasVideo) };
},
maps: { epoch: (...a) => downloadMaps.epoch(...a), wantsInterval: (...a) => downloadMaps.wantsInterval(...a),
  metadata: entry => downloadMaps.metadata(entry), withdrawMetadata: (...a) => downloadMaps.withdrawMetadata(...a),
  refresh: (...a) => downloadMaps.refresh(...a) },   // lazy: downloadMaps is built after the graph (#276)
baseUrl: () => localBaseUrl,                          // lazy, from the graph
```

**Test:** `test/no-torrent/media-read-params.test.js`. Fakes:

```js
const file = { length: 1000, name: "film.mkv", offset: 64, portionBytes: 16,
  readHeld: async (start, end) => ({ start, end }), noteVideo: hasVideo => notes.push(hasVideo) };
const maps = { epoch: () => 7, wantsInterval: () => wanted, metadata: async entry => stated.push(entry),
  withdrawMetadata: async (sourceKey, fileIndex, statement) => withdrawn.push(statement), refresh: async () => refreshed++ };
const reads = { revision: () => 3, memoryRevision: () => 5, record: () => finished };
const revision = { storage: 3, memory: 5, demand: 7 };
```

---

## 5. Encoder input (#ttv-275)

**Module:** `services/encode/EncodeInputResolution.js` (rule
`services/encode/*.js`). Imports nothing.

```js
export class EncodeInputResolution {
  constructor({
    paramsFor,        // (request) => Promise<Params | null>     — MediaReadParams#paramsFor
    sourceRanges,     // SegmentSourceRanges (tracksOf, shiftOf, navigable, readInput)
    selectTracks,     // segment-reading
    readingInterval,  // segment-reading
    trackFor,         // segment-reading
    declaredTracks,   // (sourceKey, fileIndex) => Track[] | undefined   — containerOrchestrator.tracks.get(`${s}:${f}`)
    known,            // (sourceKey, fileIndex) => container | null | undefined
    outputs,          // () => Iterable<output>                   — the output catalog's values
    log,              // (line) => void
    warn,             // (line) => void
    now = Date.now,
  })
  async resolve(output, fromIndex, toIndex, timing = null, isCurrent = null, signal = null, readPriority = null)
  stretchCopied(output, from, to, input)   // → void
}
```

`EncodeInputs` calls them with these exact positional arguments.

**`resolve`, normative** (`server.js:1070-1149`):

1. `grid = output.timeline?.published ?? output.timeline?.boundaries`; `from =
   grid?.[fromIndex]`, `to = grid?.[toIndex + 1]`; `!Number.isFinite(from) ||
   !(to > from)` → `{ kind: "terminal", reason: "output-interval-not-declared" }`.
2. Choices grouped by file, picture first: for `type` of `["video",
   "audio"]` with `spec = output.spec[type]`, push `{ type, index: type ===
   "video" ? null : spec.trackIndex, mode }` (`video`: `spec.encode ?
   "transcode" : "copy"`; `audio`: `spec.transcode ? "transcode" : "copy"`)
   under `spec.fileIndex`, files in first-seen order.
3. Per file, in order:
   1. `params = await paramsFor({ sourceKey: output.file.sourceKey, fileIndex,
      requestId: readPriority?.requestId, readPriority, signal })`; `null` →
      `{ kind: "needs-source" }`.
   2. `isCurrent` → `params.isCurrent = isCurrent`; `signal` → `params.signal =
      signal`; `timing` → `params.walkAccount = timing.walk ??= { lockMs: 0,
      reads: 0, bytes: 0 }` and `params.onTimed = (statement, waitedMs, readMs)
      => {…}` adding to `timing.reads`, `timing.queuedMs`, `timing.readMs` and
      `timing.readsByStatement[statement] ??= { queuedMs: 0, readMs: 0 }`.
   3. `tracks = await sourceRanges.tracksOf(params)`; non-result → returned
      (`needs-index` included).
   4. `selection = selectTracks(tracks.trackList, choices)`; `null` → `{ kind:
      "terminal", reason: "selected-track-is-absent" }` (no `media-info` read).
   5. `media = await sourceRanges.shiftOf(params)`; non-result → returned;
      `timeShiftSeconds = media.shift`.
   6. `sourceInterval = output.timeline.sourceInterval(fromIndex, toIndex,
      timeShiftSeconds)`; `params.packetInterval =
      readingInterval(selection, sourceInterval)`.
   7. `navigation = await sourceRanges.navigable(params)`; non-result →
      returned. Kept: `{ fileIndex, choices, params, wanted, modes,
      timeShiftSeconds, sourceInterval, navigable: navigation.value }`.
4. `original = output.segmentFormat.supportsOriginalInput === true &&
   files.every(file => file.navigable)`.
5. Per file, in order: `read = await sourceRanges.readInput(params, { original,
   tracks: wanted, modes, interval: sourceInterval })`; non-result → return
   `read.answer`. Original → `{ sourceKey: params.sourceKey, fileIndex,
   timeShiftSeconds, input: { ...read.input, original: true, selections:
   wanted.map(track => ({ track, index: track.declaredIndex ??
   choices.find(choice => choice.type === track.type)?.index ?? 0 })) } }`;
   packets → `{ sourceKey: params.sourceKey, fileIndex, input: read.input,
   timeShiftSeconds }`.
6. `{ kind: "result", sources }`.

**`stretchCopied(output, from, to, input)`, normative** (`server.js:1158-1191`).
For each `source` of `input.sources ?? []`:

1. `container = known(source.sourceKey, source.fileIndex)`, `tracks =
   declaredTracks(source.sourceKey, source.fileIndex)`; skip unless
   `typeof container?.learnPackets === "function" && Array.isArray(tracks)`.
2. `carried` = track numbers of `source.input.selections ?? []`; `sounds` =
   for every `other` of `outputs()` with no `spec.video`, a `spec.audio` on the
   same source and file: `track = trackFor(tracks, { type: "audio", index:
   other.spec.audio.trackIndex })`, added when present and not carried.
3. Skip when `sounds` is empty or `source.input.from`/`to` is not a finite,
   increasing pair.
4. `read(start, end)`: `answer = input.read(source.fileIndex, start, end)`;
   the bytes only when `answer` is not a promise and `answer.end === end`,
   else `null`. `holdsUntil(start)`: `input.heldUntil(fileIndex, start)` when
   present, else one past the end of the `source.input.ranges` range holding
   `start`, else `null`.
5. `startedAt = now()`; `release = input.retain?.()`; `void
   container.learnPackets({ from: source.input.from, to: source.input.to,
   trackIds: [...sounds] }, read, holdsUntil).then(log …, warn …).finally(()
   => release?.())` with the two lines of `server.js:1184-1188`, unchanged:

```
`encode input #${from}..#${to} of ${output.outputKey}: soundtrack packets of track(s) ${[...sounds].join(",")} ` +
`over ${source.input.from.toFixed(3)}-${source.input.to.toFixed(3)}s ` +
(learned === "walked" ? "walked" : `not all walked (${learned === "memory" ? "memory refused" : "the copy does not hold the rest"})`) +
` from its copy in ${now() - startedAt}ms`
`encode input #${from}..#${to} of ${output.outputKey}: walking the soundtrack from its copy failed: ${error?.message ?? error}`
```

**Wiring.** `wireOutputs` takes `encodeInputResolution = null` instead of
`resolveEncodeInput` and `stretchCopied`, and builds `EncodeInputs` when
`typeof encodeInputResolution?.resolve === "function"` with `resolve: (...args)
=> encodeInputResolution.resolve(...args)` and `stretchCopied: (...args) =>
encodeInputResolution.stretchCopied(...args)`. `server.js`:

```js
const encodeInputResolution = new EncodeInputResolution({
  paramsFor: request => mediaParams.paramsFor(request), sourceRanges,
  selectTracks, readingInterval, trackFor,
  declaredTracks: (sourceKey, fileIndex) => containerOrchestrator.tracks.get(`${sourceKey}:${fileIndex}`),
  known: (sourceKey, fileIndex) => containerOrchestrator.known(sourceKey, fileIndex),
  outputs: () => outputs.values(),   // lazy: the catalog of the graph built next
  log: line => logger.info(line), warn: line => logger.warn(line),
});
```

**Test:** `test/no-torrent/encode-input-resolution.test.js`, with the real
segment-reading functions and a real `SegmentSourceRanges` over a fake
orchestrator whose answers are keyed by `${fileIndex}:${statement}`:

```js
const output = { outputKey: "src:out", file: { sourceKey: "src" },
  spec: { video: { fileIndex: 0, encode: false }, audio: { fileIndex: 1, trackIndex: 0, transcode: true } },
  timeline: new Timeline({ boundaries: [0, 4, 8, 12], cutGrid: "keyframe" }),
  segmentFormat: { supportsOriginalInput: true } };
const paramsFor = async request => ({ ...request });   // a new object per call
// stretchCopied:
const container = { learnPackets: async (interval, read, holdsUntil) => { walked.push({ interval, read, holdsUntil }); return "walked"; } };
const input = { sources: [{ sourceKey: "src", fileIndex: 0,
  input: { from: 0, to: 4, ranges: [[0, 99]], selections: [{ track: videoTrack }] } }],
  read: (fileIndex, start, end) => ({ end, bytes: Buffer.alloc(end - start + 1) }), retain: () => () => released++ };
const soundOutput = { spec: { audio: { fileIndex: 0, trackIndex: 1 } }, file: { sourceKey: "src" } };
```

Existing `encode-inputs*.test.js` and `segments-are-shared.test.js` pass
unchanged.

---

## 6. The output graph first; viewer changes as an event (#ttv-276)

**`wire-outputs.js`.** Imports `EventEmitter` from `node:events`. Before
`parts.viewers` it sets `parts.viewerChanges = new EventEmitter()`. The
`Viewers` `onChange` becomes `parts.lifecycle.observeUse();
parts.encodeRuns.planEncodersSoon(); parts.viewerChanges.emit("change");`. The
`onViewerChanged` option is removed. A listener's throw reaches the code that
changed the viewers, as the callback's did.

**Module:** `services/server/start-playback.js` (rule `services/server/*.js`).
Imports nothing. This is the seam the start order is tested through, since
`server.js` cannot run in a test.

```js
/**
 * @param {object} graph
 * @param {{ viewerChanges: import("node:events").EventEmitter,
 *           lifecycle: { adoptSegmentsLeftBehind(): object } }} graph.outputParts
 * @param {{ viewersChanged(): Promise<unknown> }} graph.downloadMaps
 * @param {() => { refresh(): unknown }} graph.preparation   — read when a change comes, never at the call
 * @param {() => void} graph.onStateChanged
 * @param {(line: string) => void} graph.warn
 * @returns {object} what `adoptSegmentsLeftBehind` returned
 */
export function startPlayback({ outputParts, downloadMaps, preparation, onStateChanged, warn })
```

1. `outputParts.viewerChanges.on("change", () => { void
   preparation().refresh(); void downloadMaps.viewersChanged().catch(error =>
   warn(`download maps after a viewer change: ${error.message}`));
   onStateChanged(); })` — one listener, the three calls in the order of
   `server.js:1053-1055`. `preparation` is a getter because the source
   preparation is constructed AFTER adoption, as today (below); `startPlayback`
   itself never calls it.
2. `return outputParts.lifecycle.adoptSegmentsLeftBehind();` — after the
   subscription, so whatever the adoption or anything after it changes about
   viewers reaches the maps.

**Startup order: adoption does not move.** On `origin/main` adoption
(`server.js:1380`) comes after `startupCpuProfile` (`:1353`) and
`startProcessorReport` (`:1360`) and before `publishNative` (`:1381`) and `new
SourcePreparation` (`:1392`). It stays exactly there: `startPlayback(…)`
replaces the line `outputParts.lifecycle.adoptSegmentsLeftBehind();` in place.
The ONLY new ordering constraint this change adds is: **the viewer-change
subscription exists before adoption** — and `startPlayback` gives that by
construction (subscribe, then adopt, in one synchronous call). Nothing else
moves relative to adoption.

`preparation: () => sourcePreparation` names a `const` declared a few lines
later. That is safe: between `startPlayback` and `const sourcePreparation = …`
there is no top-level `await`, the server does not listen yet and no route is
registered, and adoption emits no viewer event (`SegmentStore#adoptWhatSurvived`
only reads and sweeps the disk and logs), so no `"change"` can be emitted
before `sourcePreparation` is initialised. Today the same window is covered by
`let sourcePreparation` plus `sourcePreparation?.refresh()`.

**`server.js` order after #276** (no `await` between steps 3 and 10):

1. Registry, torrent pool, startup measurements, chapters, subtitles (as now).
2. `sourceRanges`, `mediaReads`, `probeReads`, `indexMemory`, `mediaParams`,
   `keyframeTables`, `encodeInputResolution`.
3. `const outputParts = wireOutputs({ …, encodeInputResolution })` — no
   `onViewerChanged`.
4. `const { viewers, viewerRequests, outputs, encodeRuns, serving, renditions,
   encodeInputs, segmentStore, quality, lifecycle, priority, outputTimes,
   machineBudget, lookaheadSeconds, segmentDurationSec, localBaseUrl,
   encodeOrchestrator, encodeCost, playedOutputsOf } = outputParts;` — every
   later use, routes included, reads these names (all are assigned
   synchronously inside `wireOutputs` and never replaced). Locals that would
   shadow them are renamed (`publishNative`'s `viewers`).
5. `const resolution = new PlaybackResolution({…})` (§3).
6. `const downloadMaps = new DownloadMaps({ publish, pack, log, observeWait,
   fileWanted: (sourceKey, fileIndex) => viewers.forSource(sourceKey).some(viewer
   => viewer.source?.selectedFileIndex === fileIndex ||
   viewer.source?.visibleFileIndices?.includes(fileIndex)), resolvePlayback: map
   => resolution.resolve(map) })` — `outputPartsReady` is gone; the graph
   exists, so the guard has nothing to guard. (Steps 5-6 are new positions for
   objects with side-effect-free constructors; `DownloadMaps` was built before
   the graph and is now built right after it, with nothing between that reads
   it.)
7. `startupProfile`, `startProcessorReport` (as now, same place relative to
   adoption).
8. `startPlayback({ outputParts, downloadMaps, preparation: () =>
   sourcePreparation, onStateChanged, warn: line => logger.warn(line) })` — at
   the line where `server.js:1380` adopts today.
9. `publishNative` (or, after #280, `preparationReads`); `const
   sourcePreparation = new SourcePreparation({…})` — `const`, not `let`; `?.`
   on it dropped everywhere.
10. `outputParts.subtitleReadyFor = …`, `playbackPlanner`, routes, `listen` (as
    now).

Closures created in step 1-2 that name `downloadMaps`, `sourcePreparation`,
`resolution` or a graph name are called only after `listen` (pieces arrive and
sources are forgotten only once a source was opened), as the existing forward
references of `server.js:259-261` already are.

**Test:** `test/no-torrent/start-playback.test.js`:

```js
const { manager, store, cleanup } = managerWithOwnStore();
const key = outputSpec({ sourceKey: "torrent:abc", transcodeVideo: true, width: 1280, height: 720, audioSeparate: true }).toKey();
writeFileSync(path.join(store.directoryFor(key), "segment-00000.mp4"), Buffer.alloc(10));   // left by an earlier process
const calls = [];
const adopt = manager.lifecycle.adoptSegmentsLeftBehind.bind(manager.lifecycle);
manager.lifecycle.adoptSegmentsLeftBehind = () => { calls.push(`adopt:${manager.viewerChanges.listenerCount("change")}`); return adopt(); };
let preparationRead = 0;
startPlayback({ outputParts: manager,
  downloadMaps: { viewersChanged: async () => { calls.push("maps"); return []; } },
  preparation: () => { preparationRead += 1; return { refresh: () => { calls.push("preparation"); } }; },
  onStateChanged: () => calls.push("state"), warn: line => warnings.push(line) });
// preparationRead === 0 here: the getter is not read during startPlayback or adoption
```

Then a viewer change (`manager.viewers.present("viewer-1")`), and an output on
`key` joined by a present viewer, read through `manager.playedOutputsOf`.

---

## 6.5 The rest of the facts and long closures out of `server.js` (#ttv-280)

Issue torrent-tv/meta#280, step 6.5 of the parent: after #276, before #277.
Acceptance: the #277 check passes on the branch; `wc -l server.js` < 900; one
test per moved owner, written before its move. Every move is verbatim, every
free variable a port, each owner under an existing biome rule with no new
exception.

### A. What the check would refuse

**What the #277 check would refuse after #276, and where it goes** (each moved
verbatim, every free variable a port):

| Today | Lines | Owner |
|---|---|---|
| source preparation `inspect` port and `publishNative` | `server.js:1381-1391`, `1442-1536` (95 lines, its `onReadResult` 56) | `services/server/PreparationReads.js` |
| `forwardedSessionResponseStarts` and the three hooks using it | `server.js:157-167`, `187-214` | `services/server/forwarded-response-log.js` |
| `workTagsLogged` | `server.js:1635-1647` | `services/media/WorkTagsReport.js` |
| `preparedAddresses`, `watchedAddresses` of `EncodeAdmission` | `wire-outputs.js:1127-1156` | `services/viewer/watched-addresses.js` |
| the per-file grouping in `applyDownloadShare` | `wire-outputs.js:777-788` | `watchedFiles` in `services/storage/processor-share.js` |

```js
// services/server/PreparationReads.js — imports nothing
export class PreparationReads {
  constructor({
    paramsFor,            // (work) => Promise<Params | null>                      — MediaReadParams#paramsFor
    containers,           // { inspect(params, statement) → Promise<Answer>, containerFor(params) → Promise<Container> }
    subtitles,            // { inspectFile(params) → Promise<Answer>, inspectPackets(params) → Promise<Answer> }
    fileLengthOf,         // (sourceKey, fileIndex) => number | undefined
    viewersOf,            // (sourceKey) => Viewer[]                                — Viewers#forSource
    segmentSeconds,       // number                                                 — the graph's segmentDurationSec
    preparationInterval,  // (role, from, segmentSeconds) => interval               — viewer/SourcePreparation.js
    segmentInputs,        // ({ index, tracks }) => { forInterval(interval) }      — new SegmentInputs(…)
    nativeMaps,           // { packets(input) → Promise<zones>, original(input) → Promise<zones> }   — nativeSourceMap / nativeOriginalSourceMap
    maps,                 // { metadata(entry) → Promise, native({ sourceKey, fileIndex, zones }) → Promise }
    record,               // (params, statement, result, storage, memory) => boolean   — MediaReadRequests#record
    planEncodersSoon,     // () => void
  })
  async inspect(work, preparation)        // the body of server.js:1443-1535; returns its Answer
  async publishNative(work, preparation)  // the body of server.js:1382-1390
}
// preparation = { accepts(work), demandFor(work), bytesChanged(sourceKey, fileIndex), result(work, result), urgentReadyFor(viewer) }
// server.js: inspect: work => preparationReads.inspect(work, sourcePreparation);
//            reprice: … preparationReads.publishNative(work, sourcePreparation) …
```

```js
// services/server/forwarded-response-log.js — imports nothing
export function installForwardedResponseLog(app, { log, warn, now = () => performance.now() })
// registers, at the place of server.js:187, the onRequest, preSerialization and onSend hooks of server.js:187-214
// with the same [forecast-http] and [http-response] lines; the WeakMap of request starts lives here.

// services/media/WorkTagsReport.js — imports ./ContainerOrchestrator.js (describeWorkTags)
export class WorkTagsReport {
  constructor({ log })
  note({ sourceKey, fileIndex }, label, result)  // logs `container metadata "${label}": ${describeWorkTags(result)}`
}                                                // once per file, for results that are neither "pending" nor "needs-ranges"

// services/viewer/watched-addresses.js — imports ./choices.js
export function preparedAddresses(viewers, outputs)            // → Set<string>
export function watchedAddresses(viewers, outputs, finished)   // → Set<string>; finished: (output) => boolean

// services/storage/processor-share.js — imports nothing new (rule services/storage/*.js: utils only)
export function watchedFiles(outputs, { watched, lengthOf, encodeCostOf })
// → Array<{ bytesPerFilmSecond, encodeCostSec }>, one per output.file.key in first-seen order, of the outputs
//   with watched(output); bytesPerFilmSecond = lengthOf(first watched output of the file) / Number(output.file.durationSeconds);
//   encodeCostSec = Σ encodeCostOf(output) over the file's watched outputs; only finite positive bytesPerFilmSecond kept.
```

The three ports are arrows built inside `parts.applyDownloadShare` in
`wire-outputs.js` (each one expression, so no long closure), from the same
fields `wire-outputs.js:779-786` reads today:

```js
const watched = watchedFiles(parts.outputs.values(), {   // imported from ../storage/processor-share.js, as downloadShare is
  watched: output => parts.viewers?.forOutput(output)?.size > 0,
  lengthOf: output => Number(output.file.lengthBytes ?? parts.hostLoad.fileLengthByKey.get(output.file.key)),
  encodeCostOf: output => {
    const state = parts.encodeRuns.runStateOf(output);   // processCanBeSignalled, ENCODE_RUN_STATE: already imported by wire-outputs.js
    return processCanBeSignalled(state) && state !== ENCODE_RUN_STATE.SUSPENDED
      ? parts.encodeCost.loadOfOutput(output.outputKey)?.costSec ?? 0 : 0;
  },
});
```

`lengthOf` reads `HostLoad#fileLengthByKey` (a `Map` the host load keeps, read
here, not made); `encodeCostOf` reads `EncodeCost#loadOfOutput(outputKey).costSec`
and `EncodeRuns#runStateOf(output)`. `applyDownloadShare` then passes
`watched` to `downloadShare` as `files`, as now.

### B. Startup host measurements (`server.js:286-382`)

```js
// services/encode/measure-host.js — imports ./hwaccel.js, ./calibration.js, ./fingerprint.js,
//                                   ./start-stop-cost.js, ./audio-calibration.js (rule services/encode/*.js)
export async function measureHost({ ffmpegBin, logger, transcode, processorCores, measures = DEFAULT_MEASURES })
// → { videoEncoder, decodeCostModel, contentionPenalties, calibration, copySpeedX, audioCalibration, startStopCost, tonemapSupported }
// measures = { detectVideoEncoder, benchmarkDecodeCost, benchmarkContention, readHostFingerprint, calibrateEncoder,
//              softwareDescriptor, benchmarkCopySpeed, benchmarkAudio, measureStartAndStop, detectTonemapSupport }
//   — the real functions by default; a test passes fakes, so no ffmpeg runs.
```

The body is `server.js:286-382` verbatim with `transcodeAudio` renamed
`transcode`: the same awaits in the same order (encoder detection, decode
cost, contention, fingerprint, calibration of the chosen encoder then of
software, the fall-back to software with the same `calibration: … encoding in
software instead` warning, copy speed, audio, start/stop cost, tonemap), and
`transcode === false` gives `null`/`[]`/`false` without calling any measure.
`HostCalibration` is constructed inside, as now. `processorCores =
processorBound().cores` stays in `server.js` (the encode layer may not import
`storage/`) and is read just before the call instead of just after the
detection — a synchronous read of the process's CPU quota, which detection
does not change. `server.js` keeps `getPort` where it is and destructures the
result into the same names the `wireOutputs` call passes (`server.js:1210-1217`).

Test: `test/no-torrent/measure-host.test.js` — order of the measure calls;
software fall-back when the device's modes are empty; nothing measured
without `transcode`.

### C. The subtitle walk (`server.js:393-404`, `422-512`)

```js
// services/media/SubtitleWalk.js — imports ./SubtitleOrchestrator.js, ./SubtitleCues.js,
//                                  ./ContainerOrchestrator.js (CONTAINER_HEAD_BYTES), ../../utils/coalesce.js
export class SubtitleWalk {
  constructor({
    torrents,       // { knownTorrent(sourceKey), heldRangesOf(torrent, fileIndex), readHeldOf(torrent, fileIndex, start, end) }
    containers,     // { known(sourceKey, fileIndex), containerFor(params) }   — containerOrchestrator
    paramsFor,      // (request) => Promise<Params | null>                    — MediaReadParams#paramsFor (lazy arrow)
    wantedSeconds,  // (sourceKey, fileIndex) => whatever viewerStartsOn(priority.mapFor(sourceKey, fileIndex)) returns; lazy arrow over the graph
    publish,        // (entry) => void                     — onSubtitleCues?.(entry)
    log, warn,
  })
  subtitles                          // the SubtitleOrchestrator, built in the constructor as server.js:493-512 builds it
  heldFileFor(sourceKey, fileIndex, known = null)   // server.js:422-460, verbatim
  pushFreshCues(sourceKey, fileIndex)               // the coalescing walk of server.js:470-491, same log lines
}
```

`server.js` keeps `const subtitleWalk = new SubtitleWalk({…})` where
`heldFileFor` was and reads `subtitleWalk.subtitles` and
`subtitleWalk.pushFreshCues` where it read `subtitles` and `pushFreshCues`
(`onPiecesArrived`, `mediaReads`, routes). The chapters wiring
(`server.js:405-421`) stays.

Test: `test/no-torrent/subtitle-walk.test.js` — a held file from a fake pool,
`null` for an unknown torrent or an empty file, the container built once, one
walk at a time with one more after it, the `subtitle push …` lines.

### D. Torrent-pool ports of the output graph (the `wireOutputs` call)

```js
// services/server/torrent-pool-ports.js — imports nothing
export function torrentPoolPorts({ torrentPool, sourceRegistry, wholeFilesRoot })
// → { readEncodeRanges, openEncodeWholeFile, readEncodeHeldRanges, spillDisk, wholeFiles, memoryClaimant,
//     getTorrentTotals, setDownloadRate, setSpeculativeHold, getSourceStats, fetchWholeFile }
//   each the expression of server.js:1193-1204, 1228-1260, 1267-1268, 1293-1307, 1333-1348, verbatim;
//   `wholeFiles.root` is `wholeFilesRoot` (server.js passes completedFilesRoot(), evaluated at the same moment as now).
```

`server.js` spreads `...torrentPoolPorts({ torrentPool, sourceRegistry,
wholeFilesRoot: completedFilesRoot() })` into the `wireOutputs` options;
`setPriorityMap`, `getContainerMediaInfo` and the planner ports stay, as they
name owners of `server.js`.

Test: `test/no-torrent/torrent-pool-ports.test.js` — a pool without
`allowSpillBytes`/`allowWholeFileBytes`/`allowMemoryBytes` gives `null`
claimants; `getSourceStats` is `null` without a record or torrent and on a
throw; `fetchWholeFile` fills the file in the background; ranges read through
the known torrent.

### E. Line budget

From 1805 lines: #271-#275 remove about 520, #276 about 0, A about 140, B
about 90, C about 105, D about 70 (each net of its wiring) — about 880. If
`wc -l server.js` is still 900 or more after A-D, #280 moves next, in this
order and only as far as needed: the chapters wiring (`server.js:405-421`)
into `services/server/chapter-ports.js`, then the `onPiecesArrived` handler
(`server.js:262-278`) into `services/server/pieces-arrived.js`. #280 records
the final count.

### F. Tests

One file per owner, each written and failing before its move:
`preparation-reads.test.js`, `forwarded-response-log.test.js` (a Fastify
`app.inject`, no `listen`), `work-tags-report.test.js`,
`watched-addresses.test.js`, `processor-share.test.js` (extended with
`watchedFiles`), `measure-host.test.js`, `subtitle-walk.test.js`,
`torrent-pool-ports.test.js`.

**biome.json.** Unchanged. The new files are under existing rules with no new
exception. The `!services/server/wire-outputs.js` exception stays: that file
imports the components it assembles, which is its job and which no step
changes.

---

## 7. The check (#ttv-277)

**Test:** `test/no-torrent/composition-root-states-no-facts.test.js`, in the
style of `manager-surface.test.js`: it READS `server.js` and
`services/server/wire-outputs.js` as text.

- *Lines considered:* every line whose first non-space characters are not
  `//`, `/*` or `*`; a trailing `// …` is stripped.
- *State:* a line matching `/\bnew\s+(Map|WeakMap|Set|WeakSet)\s*\(/` is
  refused in either file, wherever it is. Text cannot tell a temporary from
  state created lazily inside a closure (`server.js:545`, `:940`), so neither
  is allowed.
- *Long closures:* a closure starts on a line that ends with `=> {`, or with
  `function …(…) {`, or is a method shorthand `name(…) {` / `async name(…) {`
  (not `if`, `for`, `while`, `switch`, `catch`). It ends at the first later
  line indented no deeper whose first non-space character is `}`. More than
  `LONGEST_CLOSURE_LINES = 40` lines from start to end, inclusive, is
  refused. The two assembly functions themselves
  (`export async function startProxyServer(`, `export function wireOutputs(`)
  are exempt; nothing else is.
- *`server.js` only:* no `outputPartsReady`, no `let sourcePreparation`, no
  `encodeMetadataRequests`, and at most `OUTPUT_PARTS_REACHES = 10` matches of
  `/\boutputParts\./g`.
- Each refusal names the file, the line and the reason, as
  `check-tests-start-no-torrent.mjs` does.

**Depends on #276 and #280.** Everything the check refuses after #276 is
moved by #280 (§6.5); #277 adds the check, proves it once, and moves nothing.
Run on `main` after #280 it passes with no exception list.

---

## 8. Documents (#ttv-278)

- `AGENTS.md`: the `server.js` line says what is left there (§ below) and the
  `services/` section names `media/segment-reading.js`,
  `media/SegmentSourceRanges.js`, `torrent/PlaybackResolution.js`,
  `server/MediaReadParams.js`, `encode/EncodeInputResolution.js`,
  `server/start-playback.js`, `server/PreparationReads.js`,
  `server/forwarded-response-log.js`, `server/torrent-pool-ports.js`,
  `media/WorkTagsReport.js`, `media/SubtitleWalk.js`,
  `encode/measure-host.js`, `viewer/watched-addresses.js` with their layer.
- `docs/download-architecture.md`: the segment → bytes projection is
  `PlaybackResolution` over `SegmentSourceRanges` and `segment-reading.js`; the
  `playedOutputsOf` port; the start order.
- `docs/encode-architecture.md`: the encoder input is `EncodeInputResolution`
  over the same two.
- `CHANGELOG.md`: nothing, because no log line changes.
- The parent's criteria are measured and recorded on torrent-tv/meta#270.

## What remains in `server.js`

Creating Fastify and its hooks (through `installForwardedResponseLog`), the
registry and the torrent pool, the call to `measureHost`, the construction of
every owner with its ports, the order of §6, the route registrations and
`listen`. No collection, no closure over 40 lines, no algorithm, under 900
lines.

## Parent criteria

| torrent-tv/meta#270 criterion | After this change |
|---|---|
| `server.js` < 900 lines | Yes, by #280 (§6.5 E): about 880 after its moves A-D, with further moves named there if needed. #271-#276 alone leave about 1150. |
| `outputParts.` ≤ 10 | Yes (§6 step 4), checked by §7. |
| no `new Map/WeakMap/Set/WeakSet` in `server.js` | Yes, checked by §7. |
| no `outputPartsReady` | Yes (#276), checked by §7. |
| CI green | Every step. |
| Home Assistant: two-hour AVI and MKV, seek, audio switch; `download map passes … longest Nms`, P4.1 outcomes and time to first segment no worse | Field check after #273 and after #280, by the field agent, on the host only. |

## Risks

- **Identity caches silently off.** A copied track list, timeline or choices
  array, or a rebuilt `joined`, turns every pass back into whole work
  (torrent-tv/meta#178). The identity scenarios in the specs pin each one.
- **A lost `map.isCurrent()` after an await** sends stale windows. §3 lists the
  nine checks and the one await deliberately left without one
  (`directSegmentInput`); the tests flip `isCurrent` at each await.
- **Start order.** `const` instead of late binding turns a too-early call into
  a `ReferenceError` instead of a silent `[]`; §6 keeps every such call after
  `listen`, keeps adoption at its place of today, and `start-playback.test.js`
  pins subscription before adoption and that the preparation getter is not read
  during it.
- **The line budget of #280** is an estimate; §6.5 E names the next moves and
  #280 does not close above 900.
- **Merge conflicts.** Each sub-issue is one PR rebased on `main` just before
  merge; the verbatim move is its own commit so a conflict is resolved by
  re-copying the region.
- **The equivalence test** generates media with `ffmpeg-static`; it is
  temporary and deleted after #273 merges.
