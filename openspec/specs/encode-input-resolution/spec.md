# encode-input-resolution Specification

## Purpose
One module works out an encoder run's input, including the soundtrack walk from a picture's copy, so the output graph receives a single object instead of separate closures.

## Requirements

### Requirement: One owner works out an encoder run's input

`services/encode/EncodeInputResolution.js` SHALL export `class
EncodeInputResolution` with `resolve(output, fromIndex, toIndex, timing,
isCurrent, signal, readPriority)` and `stretchCopied(output, from, to,
input)`, constructed with the ports `paramsFor`, `sourceRanges`,
`selectTracks`, `readingInterval`, `trackFor`, `declaredTracks`, `known`,
`outputs`, `log`, `warn` and the optional `now`. It MUST import nothing.

#### Scenario: The layer rule holds

- **WHEN** `npx biome lint` runs
- **THEN** `services/encode/EncodeInputResolution.js` passes the
  `services/encode/*.js` rule

#### Scenario: Optional arguments

- **WHEN** `resolve(output, 0, 1)` is called
- **THEN** `paramsFor` receives `requestId: undefined, readPriority: null,
  signal: null`, and the params read get no `isCurrent`, `walkAccount` or
  `onTimed`

### Requirement: wireOutputs takes one object

`wireOutputs` SHALL take the `encodeInputResolution` option in place of
`resolveEncodeInput` and `stretchCopied`, and build `EncodeInputs` with that
object's two methods when it has a `resolve` method.

#### Scenario: server.js passes one object

- **WHEN** `server.js` is read after #275
- **THEN** its `wireOutputs` call has `encodeInputResolution` and neither
  `resolveEncodeInput` nor `stretchCopied`

#### Scenario: Existing tests

- **WHEN** `npm test` runs
- **THEN** `encode-inputs*.test.js` and `segments-are-shared.test.js` pass
  with unchanged assertions

### Requirement: The run's interval and choices

`resolve` SHALL return `{ kind: "terminal", reason:
"output-interval-not-declared" }` when the output's grid (`published` or
`boundaries`) gives no finite start at `fromIndex` or no later end at `toIndex
+ 1`. It SHALL group the choices by file in first-seen order, picture first:
video `{ index: null, mode: spec.encode ? "transcode" : "copy" }`, audio `{
index: spec.trackIndex, mode: spec.transcode ? "transcode" : "copy" }`.

#### Scenario: An undeclared interval

- **WHEN** `toIndex + 1` is past the end of the grid
- **THEN** `resolve` returns `output-interval-not-declared` and calls no port

#### Scenario: Two files

- **WHEN** the picture reads file 0 and the soundtrack file 1
- **THEN** every read of file 0 comes before the first read of file 1

### Requirement: Each file is read in the order it was before

For each file `resolve` SHALL await, in order, `paramsFor({ sourceKey,
fileIndex, requestId: readPriority?.requestId, readPriority, signal })`,
`sourceRanges.tracksOf(params)`, `sourceRanges.shiftOf(params)` and
`sourceRanges.navigable(params)`. It SHALL return `{ kind: "needs-source" }`
for missing params and the answer itself for a non-result step, `needs-index`
included.

#### Scenario: Missing file

- **WHEN** `paramsFor` resolves `null`
- **THEN** `resolve` returns `{ kind: "needs-source" }`

#### Scenario: Ranges needed

- **WHEN** `media-info` is answered `{ kind: "needs-ranges", ranges }`
- **THEN** `resolve` returns that answer object

#### Scenario: No index yet

- **WHEN** the file's container has neither `readSourceRanges` nor
  `readPacketIndex`
- **THEN** `resolve` returns `{ kind: "needs-index", reason:
  "packet-index-not-yet-available" }`

### Requirement: Tracks are selected before media-info is read

Between the tracks and `media-info`, `resolve` SHALL call
`selectTracks(trackList, choices)` and return `{ kind: "terminal", reason:
"selected-track-is-absent" }` when it is `null`. After `media-info` it SHALL
set `params.packetInterval = readingInterval(selection,
output.timeline.sourceInterval(fromIndex, toIndex, shift))` before the
navigation is read.

#### Scenario: Absent track is terminal

- **WHEN** the output's soundtrack index names a soundtrack the file does not
  have
- **THEN** `resolve` returns `selected-track-is-absent` and `media-info` was
  never inspected

#### Scenario: The stated interval

- **WHEN** the run reads segments 1..2 of a picture copied from track 2 with a
  start time of 1.5 s
- **THEN** `params.packetInterval` holds the source interval of those segments
  shifted by 1.5 s, `trackIds: [2]` and `modes: { 2: "copy" }`

### Requirement: The run's own reading context is set on its params

`resolve` SHALL set `params.isCurrent` and `params.signal` when given, and with
`timing` SHALL set `params.walkAccount = timing.walk ??= { lockMs: 0, reads: 0,
bytes: 0 }` and a `params.onTimed(statement, waitedMs, readMs)` that adds to
`timing.reads`, `queuedMs`, `readMs` and `readsByStatement[statement]`.

#### Scenario: Timing is told

- **WHEN** `timing` is `{ reads: 0, queuedMs: 0, readMs: 0, readsByStatement:
  {} }` and a read calls `params.onTimed("packets", 5, 7)`
- **THEN** `timing` has `reads: 1, queuedMs: 5, readMs: 7`,
  `readsByStatement.packets` is `{ queuedMs: 5, readMs: 7 }` and
  `params.walkAccount === timing.walk`

#### Scenario: The run's signal

- **WHEN** `resolve` is called with an `isCurrent` function and a signal
- **THEN** every params object read has that `isCurrent` and that `signal`

### Requirement: Original input only when every file is navigable

The run SHALL read every file with `sourceRanges.readInput(params, { original,
… })`, `original` being true only when `output.segmentFormat.supportsOriginalInput
=== true` and every file's navigation is `true`. A non-result read SHALL
return `read.answer`; the result SHALL be `{ kind: "result", sources }` in file
order.

#### Scenario: Every file navigable

- **WHEN** `supportsOriginalInput` is `true` and both files' navigation is
  `true`
- **THEN** both are inspected for `source-ranges` and neither for `packets`

#### Scenario: One file not navigable

- **WHEN** file 1's navigation is `false`
- **THEN** both files are inspected for `packets`

#### Scenario: The format refuses original input

- **WHEN** `supportsOriginalInput` is `false`
- **THEN** every file is read from packets

#### Scenario: Packets refused memory

- **WHEN** `packets` is answered `{ kind: "needs-memory", bytes }`
- **THEN** `resolve` returns that answer object

### Requirement: The sources of a run

An original source SHALL be `{ sourceKey, fileIndex, timeShiftSeconds, input:
{ ...value, original: true, selections } }`, each selection `{ track, index:
track.declaredIndex ?? choices.find(choice => choice.type ===
track.type)?.index ?? 0 }`. A packets source SHALL be `{ sourceKey, fileIndex,
input, timeShiftSeconds }`.

#### Scenario: The ffmpeg selection index

- **WHEN** the original input's soundtrack has `declaredIndex: 3` and the
  picture has no `declaredIndex`
- **THEN** the soundtrack's selection index is 3 and the picture's is 0

#### Scenario: A packets source

- **WHEN** the run reads from packets
- **THEN** each source's `input` is what `SegmentInputs#forInterval` made and
  has no `original` key

### Requirement: The soundtracks to walk from the picture's copy

For each source of `input.sources` whose container (`known`) has
`learnPackets` and whose `declaredTracks` are an array, `stretchCopied` SHALL
collect the soundtracks of the other picture-less outputs of the same source
and file, found with `trackFor(tracks, { type: "audio", index:
spec.audio.trackIndex })`, that the source's selections do not carry.

#### Scenario: A soundtrack already carried

- **WHEN** the run's own selections carry that soundtrack
- **THEN** `learnPackets` is not called

#### Scenario: No container that learns packets

- **WHEN** `known` returns a container without `learnPackets`
- **THEN** that source is skipped

### Requirement: The soundtrack is walked from the picture's copy

When there are soundtracks and the source's input has a finite, increasing
`from` and `to`, `stretchCopied` SHALL retain the input, call
`container.learnPackets({ from, to, trackIds }, read, holdsUntil)` without
awaiting it, log the outcome with the two lines it logged before, and release
the input once it settles.

#### Scenario: Soundtrack walk from the copy

- **WHEN** a picture-only run's input copied `0..4 s` of file 0 and another
  output plays soundtrack 1 of the same file
- **THEN** `learnPackets` receives `{ from: 0, to: 4, trackIds: [that
  soundtrack's trackNumber] }`, `log` receives a line ending `walked from its
  copy in ${n}ms`, and the input's release is called once

#### Scenario: Bytes the copy does not hold whole

- **WHEN** `read(start, end)` is called and `input.read` returns a promise or
  an answer whose `end` is not `end`
- **THEN** `read` returns `null`

#### Scenario: Where the copy ends

- **WHEN** the input has no `heldUntil` and its ranges are `[[0, 99]]`
- **THEN** `holdsUntil(50)` is 100 and `holdsUntil(150)` is `null`

#### Scenario: A failed walk

- **WHEN** `learnPackets` rejects with `new Error("boom")`
- **THEN** `warn` receives a line ending `walking the soundtrack from its copy
  failed: boom` and the input is released
