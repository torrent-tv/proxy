# playback-resolution Specification

## Purpose
TBD - created by archiving change composition-root-owners. Update Purpose after archive.

## Requirements

### Requirement: The download-map pass has one owner

`services/torrent/PlaybackResolution.js` SHALL export `class
PlaybackResolution` with `resolve(map)`, `clear(sourceKey, fileIndex)` and
`forget(sourceKey)`. Its constructor SHALL take the ports `paramsFor`,
`sourceRanges`, `segmentReading`, `playedOutputsOf`, `pieceLengthOf`,
`noteSegmentInput`, `refresh`, `observeWait`, `log`, `warn` and the optional
`now`, `clock`, `turns`. It MUST pass the `services/torrent/*.js` lint rule.

#### Scenario: The layer rule holds

- **WHEN** `npx biome lint` runs
- **THEN** `services/torrent/PlaybackResolution.js` passes, importing only
  `./PlaybackProjection.js`, `./demand/pieces.js`,
  `../../utils/take-turns.js` and Node built-ins

#### Scenario: DownloadMaps is given the pass

- **WHEN** `server.js` is read after #273
- **THEN** `DownloadMaps` is constructed with `resolvePlayback: map =>
  resolution.resolve(map)`

### Requirement: The pass owns its state

`PlaybackResolution` SHALL own the projections, segment records, choices keys,
checked grids, made rates, pass costs and the containers whose packet table it
awaits, and `server.js` SHALL keep none of them. `forget(sourceKey)` SHALL drop
a source's projections, records and made rates; `clear(sourceKey, fileIndex)`
SHALL empty one file's projection.

#### Scenario: server.js keeps no pass state

- **WHEN** `server.js` is read after #273
- **THEN** it contains none of `playbackProjections`, `segmentReadings`,
  `choicesKeys`, `checkedGrids`, `madeRates`, `passCosts`, `refreshAfterTable`

#### Scenario: Forgetting a source

- **WHEN** `forget("src")` is called after passes over `src` and `srcB`
- **THEN** the next pass over `src` builds new records, calling
  `segmentReading` again, and the next pass over `srcB` does not

### Requirement: The output graph states what is played

`wireOutputs` SHALL return `playedOutputsOf(sourceKey, fileIndex)`: in catalog
order, one entry per output of that source with a present consumer not
superseded by its active variant and non-empty `trackChoicesOf(output,
fileIndex)`. An entry SHALL be `{ outputKey, timeline, choices, revision,
sizes, encodeSpeed, linkMbps, target }`.

#### Scenario: A watched output

- **WHEN** a present viewer joined an output of `src` that reads file 0
- **THEN** `playedOutputsOf("src", 0)` has one entry whose `timeline` is `===`
  `output.timeline`

#### Scenario: No present consumer

- **WHEN** the only viewer of the output left
- **THEN** `playedOutputsOf("src", 0)` is empty

#### Scenario: Another file

- **WHEN** the output reads file 0 only
- **THEN** `playedOutputsOf("src", 1)` is empty

### Requirement: What a played entry states

`revision` SHALL be `segmentStore.revisionOf(outputKey)`; `sizes()` SHALL
return `segmentStore.sizesOf(outputKey)`; `encodeSpeed` SHALL be
`encodeCost.latestSpeedReadingOf(output)?.speed`; `linkMbps` SHALL be the
least finite positive `linkReading().linkMbps` of the consumers, or `null`;
`target` SHALL be `encodeInputs.targetInputBytes(output)` or `null`.

#### Scenario: The slowest link

- **WHEN** two present viewers report `linkMbps` 8 and 3
- **THEN** the entry's `linkMbps` is 3

#### Scenario: No link reading

- **WHEN** no consumer has a link reading
- **THEN** the entry's `linkMbps` is `null`

#### Scenario: What was made

- **WHEN** the store holds segment 0 of the output
- **THEN** `entry.sizes()` has an entry for 0

### Requirement: The file-level reads come first

`resolve(map)` SHALL return `[]`, clearing the file's projection, when
`map.zones` is empty. It SHALL then await, in order, `paramsFor({ sourceKey,
fileIndex })`, `sourceRanges.tracksOf` and `sourceRanges.shiftOf`, and return
`[]` when params are missing, a step is not a result, or `map.isCurrent()` is
false after any of them.

#### Scenario: Map replaced while reading the tracks

- **WHEN** `isCurrent` turns false while `tracks` is inspected
- **THEN** `resolve` returns `[]` and `playedOutputsOf` was not called

#### Scenario: No zones

- **WHEN** a pass with zones is followed by one with `zones: []`
- **THEN** the second returns `[]` and the next pass with zones resolves every
  segment again from the record cache

### Requirement: The file's navigation decides the direct index

After `projection.update`, `resolve` SHALL await `sourceRanges.navigable` and
return `[]` only when it answers `stale`. The direct index SHALL be the
container from `tracksOf` when the navigation is a result with `value: true`
and the container has `readSourceRanges`, and `null` otherwise.

#### Scenario: Direct index

- **WHEN** the container is navigable and has `readSourceRanges`
- **THEN** every zone ends `resolved` with method `direct-source-index`

#### Scenario: Fallback

- **WHEN** `source-navigation` is `false`
- **THEN** zones end `resolved` with method `packet-index`

#### Scenario: Navigation not yet read

- **WHEN** the file's `source-navigation` answers `needs-ranges`
- **THEN** the pass goes on with no direct index

### Requirement: The pass yields between segments and stops when replaced

For each zone of `projection.unresolved()` the pass SHALL check
`map.isCurrent()`, await one turn and check again, returning `[]` on either
without a P4.1 event. When `sourceRanges.resolve` answers `stale` it SHALL end
that zone with `map-replaced` and return `[]`.

#### Scenario: Map replaced mid-pass

- **WHEN** `isCurrent` turns false while the second zone's ranges are being
  resolved
- **THEN** `resolve` returns `[]`, that zone's P4.1 end has outcome
  `map-replaced` and no later zone is resolved

#### Scenario: Map replaced during a turn

- **WHEN** `isCurrent` turns false during the awaited turn
- **THEN** `resolve` returns `[]` and no P4.1 event is written for that zone

### Requirement: Known segments are not asked again

For each zone the pass SHALL take the segment's record and, in order: end
`segment-reading-unavailable` and call `setUnreadable` when it has no reading;
use the record's ranges (`segment-record-cache`) or `sourceRanges.cached`
(`source-range-cache`); end `waiting-for-output-input` for an output held in
this pass; else call `map.workingOut(zone.priority, …)` and
`sourceRanges.resolve`.

#### Scenario: Absent track

- **WHEN** an output's choices name a soundtrack the file does not have
- **THEN** its zones end `segment-reading-unavailable`, `setUnreadable` marks
  them, and a second pass over the same map does not resolve them again

#### Scenario: Cache hits

- **WHEN** a second pass runs over the same map with nothing changed
- **THEN** `sourceRanges.resolve` is not called and no P4.1 event is written

#### Scenario: Record cache after the zones were cleared

- **WHEN** a pass resolved every segment, then `clear(sourceKey, fileIndex)`
  is called and the same map is resolved again
- **THEN** every zone ends `resolved` with method `segment-record-cache` and
  `sourceRanges.resolve` is not called

#### Scenario: Two outputs of the same interval

- **WHEN** two outputs with the same choices and timeline play the same file
- **THEN** the second output's segments end with method `source-range-cache`

### Requirement: The fallback is asked for the segment's own interval

The pass SHALL give `sourceRanges.resolve` an `intervalParams` thunk calling
`paramsFor({ sourceKey, fileIndex, packetInterval: interval, requestId,
demand })` with `requestId`
`` `download:${sourceKey}:${fileIndex}:${outputKey}:${index}` `` and `demand`
`{ ...zone.owner, leadSeconds: zone.leadSeconds }`, and `whenBuilt` refreshing
the map once per container when its table is built.

#### Scenario: The request of a segment

- **WHEN** segment 2 of `src:out-a` falls back
- **THEN** `paramsFor` receives `requestId: "download:src:0:src:out-a:2"` and
  the zone's owner fields with `leadSeconds`

#### Scenario: Pending holds the output

- **WHEN** the direct index answers `pending` for the first segment of an
  output
- **THEN** that zone ends `source-index-pending`, the output's next zone in
  the same pass ends `waiting-for-output-input`, and once the table settles
  `refresh(sourceKey, fileIndex)` is called exactly once

### Requirement: Each answer has its P4.1 outcome

`result` SHALL end `resolved` with the answer's method; `pending` SHALL end
`source-index-pending` and hold the output; `needs-source` SHALL end
`source-file-unavailable`; step `navigation` SHALL end
`source-navigation-${kind}` and hold the output for `needs-ranges` and
`needs-memory`; step `packets` SHALL end `source-packets-${kind}` and hold it
for `needs-memory`; step `input` SHALL end `segment-input-${kind}`.

#### Scenario: Memory refused

- **WHEN** `packets` is answered `needs-memory`
- **THEN** the zone ends `source-packets-needs-memory`, the output's later
  zones end `waiting-for-output-input`, and another output's zones are still
  resolved

#### Scenario: The file is gone

- **WHEN** the segment's params are `null`
- **THEN** the zone ends `source-file-unavailable` with method
  `container-index-fallback` and the pass goes on

### Requirement: Identity caches stay on

The pass MUST NOT copy or rebuild an object a cache compares by identity. A
projection SHALL be kept unless the track list or shift is not `===` or the
piece length is not `Object.is`; a segment record unless its timeline, track
list, shift or choices key is not `===`. The choices key SHALL be cached in a
`WeakMap` by the choices array.

#### Scenario: New track list object

- **WHEN** `tracks` answers a new array between two passes
- **THEN** the projection is cleared and rebuilt and every segment is
  resolved again

#### Scenario: Piece length learned

- **WHEN** `pieceLengthOf` returns `NaN` in one pass and 16 in the next
- **THEN** the projection is rebuilt and the joined ranges are recomputed

### Requirement: A segment's ranges are joined and noted once

Joined ranges SHALL be rebuilt only when the record's ranges or piece length
changed, and `noteSegmentInput(sourceKey, fileIndex, outputKey, index,
joined)` SHALL be called only when `registered !== joined`.

#### Scenario: Nothing changed

- **WHEN** two passes run with the same track list array, timeline and choices
- **THEN** `noteSegmentInput` is called once per segment over both passes

#### Scenario: Repeated AVI zones

- **WHEN** two segments of one output resolve to equal ranges, as two
  segments of one group of pictures in an AVI do (2.96.11)
- **THEN** `noteSegmentInput` is called for both indices with those ranges,
  both are set with `setRanges`, and neither is listed unresolved in the next
  pass

### Requirement: Wait-trace P4.1 events are unchanged

Each zone SHALL write a `process` event `{ process: "P4.1", phase: "begin",
resolutionId, sourceId, fileIndex, outputKey, segment, priority, deadlineAt }`
and, in `finally`, one with `phase: "end"`, the same identity fields, and
`startedAt, endedAt, durationMs, outcome, method, trackCount, rangeCount,
rangeBytes` plus, when known, `trackIds`, `sourceInterval: { from, to }` and
`error`.

#### Scenario: Fields of a resolved zone

- **WHEN** a zone resolves by `packet-index` to `[[0, 99], [200, 299]]` with
  piece length 16
- **THEN** its end event has `outcome: "resolved"`, `method: "packet-index"`,
  `rangeCount` and `rangeBytes` of the joined ranges, `trackCount` and
  `trackIds` of the reading, and `durationMs === endedAt - startedAt`

#### Scenario: Identifiers

- **WHEN** a pass started at `clock()` 1234.5 resolves segment 3 of
  `src:out-a` in file 0 of `src`
- **THEN** `resolutionId` is `0:src:out-a:3:1234.500` and `sourceId` is `src:0`

### Requirement: A thrown error ends its zone

When resolving a zone throws, its end event SHALL have outcome `error` and
`error` set to the error's message, and `resolve` SHALL reject with that error.

#### Scenario: A thrown error

- **WHEN** `sourceRanges.resolve` throws `new Error("boom")`
- **THEN** the end event has `outcome: "error"`, `error: "boom"`, and
  `resolve` rejects with that error

### Requirement: The pass report is unchanged

Each pass that reaches its windows SHALL be counted. When `now() - since >=
60000` the pass SHALL call `log` with exactly `download map passes in
${seconds}s: ${passes} map(s), ${whole} worked out whole, ${reworked}
segment(s) worked out again, ${resolved} segment(s) had their ranges worked
out, ${windows} window(s) told; ${ms}ms from start to result in all, longest
${maxMs}ms` and reset the counters.

#### Scenario: One minute of passes

- **WHEN** two passes run, `now` advances 61 000 ms and a third pass runs
- **THEN** `log` is called once with a line starting `download map passes in
  61.0s: 3 map(s), ` and ending `longest ${n}ms`, `n` rounded

#### Scenario: Within the minute

- **WHEN** passes run while `now` advances less than 60 000 ms
- **THEN** `log` is not called

### Requirement: The pass is proven equal to the closure it replaces

Until #273 is merged, a test SHALL run a verbatim copy of the old
`resolvePlayback` closure and `PlaybackResolution` side by side on local AVI,
MKV and MP4 files generated with `ffmpeg-static`, and compare windows and
noted ranges. It SHALL be removed after the merge. On the Home Assistant host
the pass's `longest Nms` SHALL be no worse than before.

#### Scenario: Same windows

- **WHEN** both sides run the same sequence of maps over the same file
- **THEN** every pass returns deep-equal windows and the same `(outputKey,
  index, joined)` notes

#### Scenario: Removed after merge

- **WHEN** #273 is merged
- **THEN** `playback-resolution-equivalence.test.js` and
  `support/resolve-playback-before-270.js` are deleted by the next commit of
  this change on `main`
