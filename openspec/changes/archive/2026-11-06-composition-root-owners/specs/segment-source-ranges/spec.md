## ADDED Requirements

### Requirement: One owner resolves a segment's source byte ranges

`services/media/SegmentSourceRanges.js` SHALL export `class
SegmentSourceRanges` constructed with `{ orchestrator }`, where `orchestrator`
has `inspect(params, statement)` and `known(sourceKey, fileIndex)`. It MUST
import only `./direct-segment-input.js` and `./SegmentInputs.js`, MUST pass the
`services/media/*.js` lint rule, and SHALL own the ranges cache that was
`segmentSourceRanges` in `server.js`.

#### Scenario: The layer rule holds

- **WHEN** `npx biome lint` runs
- **THEN** `services/media/SegmentSourceRanges.js` passes

#### Scenario: server.js keeps no ranges cache

- **WHEN** `server.js` is read after #272
- **THEN** it contains no `segmentSourceRanges` and constructs `new
  SegmentSourceRanges({ orchestrator: containerOrchestrator })` once

### Requirement: The ranges key and the cache

`keyOf(sourceKey, fileIndex, interval)` SHALL return
`` `${sourceKey}:${fileIndex}:${JSON.stringify(interval)}` ``.
`cached(rangesKey)` SHALL return `{ kind: "result", ranges, method:
"source-range-cache" }` with the very array kept under that key, or `null`.
`forget(sourceKey)` SHALL delete every key starting with `` `${sourceKey}:` ``
and no other.

#### Scenario: Cache hit

- **WHEN** `resolve` returned ranges for a key and `cached(key)` is called
- **THEN** it returns `method: "source-range-cache"` and `ranges` is `===` the
  array `resolve` returned

#### Scenario: Cache miss

- **WHEN** `cached` is called with a key never resolved
- **THEN** it returns `null`

#### Scenario: Forgetting a source

- **WHEN** ranges are kept for `src:0:…` and `srcB:0:…` and `forget("src")` is
  called
- **THEN** `cached` returns `null` for the first key and the ranges for the
  second

### Requirement: Each file-level step is one read

`tracksOf`, `shiftOf` and `navigable` (each `(params, isCurrent = () => true)`)
SHALL make one `orchestrator.inspect` call, for `tracks`, `media-info` and
`source-navigation` respectively. After it each SHALL return `{ kind: "stale"
}` when `isCurrent()` is false, and then return a non-result answer as the
same object.

#### Scenario: Replaced during the read

- **WHEN** `isCurrent` turns false while `inspect` is awaited
- **THEN** the step returns `{ kind: "stale" }`

#### Scenario: A non-result answer passes through

- **WHEN** the orchestrator answers `media-info` with `{ kind: "needs-ranges",
  ranges: [[0, 99]] }`
- **THEN** `shiftOf` returns that object itself

### Requirement: The file's tracks

On a result, `tracksOf` SHALL return `{ kind: "result", trackList, container
}`, with `trackList` the answer's `value` itself and `container =
orchestrator.known(params.sourceKey, params.fileIndex)` read after the await.
When that container has neither `readSourceRanges` nor `readPacketIndex` it
SHALL return `{ kind: "needs-index", reason: "packet-index-not-yet-available"
}`.

#### Scenario: The same track list every time

- **WHEN** the orchestrator answers `tracks` with the same array twice and
  `tracksOf` is called twice
- **THEN** both results' `trackList` are `===` that array

#### Scenario: A container that names no bytes

- **WHEN** `known` returns `{}`
- **THEN** `tracksOf` returns `{ kind: "needs-index", reason:
  "packet-index-not-yet-available" }`

### Requirement: The file's start time and navigation

On a result, `shiftOf` SHALL return `{ kind: "result", shift:
Number(value?.startTimeSeconds) || 0 }` and `navigable` SHALL return `{ kind:
"result", value: value === true }`.

#### Scenario: No start time

- **WHEN** `media-info` has no `startTimeSeconds`
- **THEN** `shiftOf` returns `shift: 0`

#### Scenario: A start time

- **WHEN** `media-info` has `startTimeSeconds: 1.5`
- **THEN** `shiftOf` returns `shift: 1.5`

#### Scenario: Navigation is strictly true

- **WHEN** `source-navigation` answers `value: "yes"`
- **THEN** `navigable` returns `value: false`

### Requirement: The run input is read from source ranges or packets

`readInput(params, { original, tracks, modes, interval }, isCurrent)` SHALL
inspect `source-ranges` when `original` is true and `packets` otherwise. It
SHALL then return `{ kind: "stale", step: "packets" }` when `isCurrent()` is
false, and `{ kind: answer.kind, step: "packets", answer }` for a non-result
answer.

#### Scenario: Original input

- **WHEN** `readInput` is called with `original: true`
- **THEN** only `source-ranges` is inspected

#### Scenario: Packets

- **WHEN** `readInput` is called with `original: false`
- **THEN** only `packets` is inspected

#### Scenario: Memory refused

- **WHEN** `packets` is answered `{ kind: "needs-memory", bytes: 1e9 }`
- **THEN** `readInput` returns `{ kind: "needs-memory", step: "packets",
  answer }`

### Requirement: The run input's ranges

`readInput` SHALL take `input` as the `source-ranges` value, or as `new
SegmentInputs({ index: value, tracks }).forInterval({ ...interval, mode: track
=> modes.get(track) })` for `packets`. A non-result `input` SHALL give `{ kind:
input.kind, step: "input", answer: input }`; a result SHALL give `{ kind:
"result", method, input }` with `method` `container-source-ranges` or
`packet-index`.

#### Scenario: Ranges from the original

- **WHEN** `source-ranges` answers `{ kind: "result", value: { kind: "result",
  ranges: [[5, 9]] } }`
- **THEN** `readInput` returns `method: "container-source-ranges"` and that
  value as `input`

#### Scenario: Ranges from the packets of the wanted tracks

- **WHEN** `packets` answers an index and the wanted track is track 2
- **THEN** `readInput` returns `method: "packet-index"` and `input.ranges` made
  by `SegmentInputs#forInterval` for track 2

### Requirement: A segment is first asked of the direct index

`resolve({ rangesKey, direct, interval, tracks, modes, intervalParams,
isCurrent, whenBuilt })` SHALL, when `direct` is given, first await
`directSegmentInput(direct, { interval, tracks, mode }, whenBuilt)`, a throw
counting as no answer, with no `isCurrent` check after it. `pending` SHALL
return `{ kind: "pending", method: "direct-source-index", step: "direct" }`; a
result SHALL be kept under `rangesKey` and returned with method
`direct-source-index`.

#### Scenario: Direct index

- **WHEN** `direct.readSourceRanges` answers ranges
- **THEN** `resolve` returns `method: "direct-source-index"`, does not call
  `intervalParams` and keeps the ranges

#### Scenario: Direct index still building

- **WHEN** `direct.packetTableWouldWait()` is true
- **THEN** `resolve` returns `{ kind: "pending", method:
  "direct-source-index", step: "direct" }` and `whenBuilt` received the
  table's promise

#### Scenario: No staleness check after the direct read

- **WHEN** `isCurrent` turns false during the direct read and it answers
  ranges
- **THEN** `resolve` still returns them with `method: "direct-source-index"`

### Requirement: Otherwise the segment is asked of the container's own reads

Without a direct answer `resolve` SHALL await `intervalParams()`, return `{
kind: "stale", step: "params" }` when `isCurrent()` is false and `{ kind:
"needs-source", step: "params" }` when there are no params, then await
`navigable` and `readInput` with `original` = the navigation's value. Every
non-result SHALL carry `method: "container-index-fallback"` and its `step`.

#### Scenario: Direct index fails, fallback by source ranges

- **WHEN** `direct.readSourceRanges` throws and `source-navigation` is `true`
- **THEN** `resolve` returns `method: "container-source-ranges"` with the
  `source-ranges` value's ranges

#### Scenario: Fallback by packets

- **WHEN** `direct` is `null` and `source-navigation` is `false`
- **THEN** `resolve` inspects `source-navigation` then `packets` and returns
  `method: "packet-index"`

#### Scenario: Navigation needs memory

- **WHEN** `source-navigation` is answered `needs-memory`
- **THEN** `resolve` returns `{ kind: "needs-memory", method:
  "container-index-fallback", step: "navigation", answer }`

#### Scenario: Packets need memory

- **WHEN** `packets` is answered `needs-memory`
- **THEN** `resolve` returns `kind: "needs-memory"`, `method:
  "container-index-fallback"`, `step: "packets"`

#### Scenario: The file is gone

- **WHEN** `intervalParams` resolves `null`
- **THEN** `resolve` returns `{ kind: "needs-source", method:
  "container-index-fallback", step: "params" }`

#### Scenario: Stale before missing

- **WHEN** `intervalParams` resolves `null` and `isCurrent` is false
- **THEN** `resolve` returns `kind: "stale"`, `step: "params"`

### Requirement: Resolved ranges are kept and errors propagate

A fallback result SHALL be kept under `rangesKey` and returned as `{ kind:
"result", ranges, method }` with `readInput`'s method. Errors not thrown by
`directSegmentInput` SHALL propagate.

#### Scenario: Kept after the fallback

- **WHEN** `resolve` returned ranges by `packet-index`
- **THEN** `cached(rangesKey)` returns the same array

#### Scenario: An orchestrator error

- **WHEN** `inspect` rejects with `new Error("boom")` during the fallback
- **THEN** `resolve` rejects with that error

### Requirement: Method names stay those of wait-trace P4.1

The method names SHALL be exactly `direct-source-index`,
`container-source-ranges`, `packet-index`, `source-range-cache` and
`container-index-fallback`.

#### Scenario: Names unchanged

- **WHEN** the tests collect every `method` the owner returns over the
  scenarios above
- **THEN** each is one of those five strings
