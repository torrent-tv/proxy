# composition-root Specification

## Purpose
Every fact that `server.js` and `wire-outputs.js` wire has a tested owner. The composition root holds no collections, no closures over 40 lines and no late binding; it builds the output graph first and starts playback before `listen`, and viewer changes are announced through the output graph. `docs/layout.md` and the architecture documents name each owner.

## Requirements

### Requirement: The output graph announces viewer changes

`wireOutputs` SHALL return `viewerChanges`, an `EventEmitter` from
`node:events`, and SHALL emit `"change"` on it whenever the viewers change,
after `lifecycle.observeUse()` and `encodeRuns.planEncodersSoon()`.
`wireOutputs` MUST NOT accept an `onViewerChanged` option.

#### Scenario: A new viewer

- **WHEN** a listener is on `manager.viewerChanges` and
  `manager.viewers.present("viewer-1")` is called
- **THEN** the listener is called once

#### Scenario: The option is gone

- **WHEN** `services/server/wire-outputs.js` is read
- **THEN** it contains no `onViewerChanged`

### Requirement: A viewer change refreshes the preparation and the maps

`services/server/start-playback.js` SHALL export `startPlayback({
outputParts, downloadMaps, preparation, onStateChanged, warn })` and import
nothing. It SHALL subscribe one `"change"` listener that calls
`preparation().refresh()`, then `downloadMaps.viewersChanged()`, then
`onStateChanged()`, awaiting none, and warns `download maps after a viewer
change: ${message}` when the maps reject.

#### Scenario: A viewer change after start refreshes maps and preparation

- **WHEN** a viewer becomes present after `startPlayback`
- **THEN** the calls are `preparation`, `maps`, `state`, in that order, once

#### Scenario: The maps' failure is reported

- **WHEN** `downloadMaps.viewersChanged()` rejects with `new Error("boom")`
- **THEN** `warn` receives `download maps after a viewer change: boom`

### Requirement: Outputs left behind are adopted after the subscription

`startPlayback` SHALL call `outputParts.lifecycle.adoptSegmentsLeftBehind()`
only after it has subscribed, return its result, and not call `preparation`.
The subscription before adoption is the only new ordering constraint:
adoption keeps its place of today relative to everything else in `server.js`.

#### Scenario: The preparation is read only on a change

- **WHEN** `startPlayback` returns
- **THEN** the `preparation` getter has not been called

#### Scenario: Subscribed before adoption

- **WHEN** `startPlayback` runs over a `managerWithOwnStore()` manager whose
  `adoptSegmentsLeftBehind` records `viewerChanges.listenerCount("change")`
- **THEN** the recorded count is 1 and `startPlayback` returns `{ adopted,
  dropped, unprovenRemoved }`

#### Scenario: Adopted outputs at start are seen by the maps

- **WHEN** a segment of an output key was left in the store by an earlier
  process, `startPlayback` adopted it, and an output with that key is then
  joined by a present viewer
- **THEN** `manager.playedOutputsOf("torrent:abc", 0)` has an entry for that
  output whose `sizes()` has an entry for segment 0

### Requirement: server.js builds the graph first and binds nothing late

`server.js` SHALL call `wireOutputs` before constructing `PlaybackResolution`,
`DownloadMaps` and `SourcePreparation`, read the graph's parts through one
destructuring of `outputParts`, declare `sourcePreparation` with `const` and
start playback through `startPlayback`. It MUST NOT contain
`outputPartsReady`, `let sourcePreparation`, `onViewerChanged` or
`adoptSegmentsLeftBehind`.

#### Scenario: No late binding

- **WHEN** `server.js` is read after #276
- **THEN** it contains no `outputPartsReady` and no `let sourcePreparation`

#### Scenario: The order of construction

- **WHEN** `server.js` is read after #276
- **THEN** `wireOutputs(` comes before `new PlaybackResolution(`, which comes
  before `new DownloadMaps(`, which comes before `startPlayback(`, which comes
  before `new SourcePreparation(`

#### Scenario: Adoption stays where it is today

- **WHEN** `server.js` is read after #276
- **THEN** `startPlayback(` stands where `adoptSegmentsLeftBehind()` stood:
  after `startupCpuProfile(` and `startProcessorReport(`, and before
  `new SourcePreparation(`

#### Scenario: Few reaches into the graph

- **WHEN** `/\boutputParts\./g` is counted in `server.js` after #276
- **THEN** there are at most 10 matches

### Requirement: The composition root holds no collections

`test/no-torrent/composition-root-states-no-facts.test.js` SHALL read
`server.js` and `services/server/wire-outputs.js` as text, import nothing from
`services/`, and fail when either contains, outside comments, a match of
`/\bnew\s+(Map|WeakMap|Set|WeakSet)\s*\(/`. Each refusal SHALL name the file,
the line and the reason.

#### Scenario: A Map added to server.js

- **WHEN** `const kept = new Map();` is added inside `startProxyServer`
- **THEN** the test fails naming `server.js`, that line and `new Map(`; this is
  proved once by doing it and is not committed

#### Scenario: Comments are not code

- **WHEN** a comment says `new Map()`
- **THEN** the test passes

### Requirement: The composition root holds no long closures

The test SHALL fail on a closure longer than 40 lines in either file, other
than `startProxyServer` and `wireOutputs` themselves. A closure starts on a
line ending in `=> {`, a `function …(…) {` or a method shorthand `name(…) {`
that is not `if`, `for`, `while`, `switch` or `catch`, and ends at the first
later line indented no deeper whose first non-space character is `}`.

#### Scenario: A long closure

- **WHEN** a closure of 41 lines is added to `wire-outputs.js`
- **THEN** the test fails naming its first line

#### Scenario: A closure of 40 lines

- **WHEN** a closure of exactly 40 lines is added
- **THEN** the test passes

### Requirement: server.js names no late binding

The test SHALL also fail when `server.js` contains `outputPartsReady`, `let
sourcePreparation` or `encodeMetadataRequests`, or more than 10 matches of
`/\boutputParts\./g`.

#### Scenario: Late binding comes back

- **WHEN** `let outputPartsReady = false;` is added to `server.js`
- **THEN** the test fails naming that line

#### Scenario: Today's code

- **WHEN** the test runs on `3473cf3`
- **THEN** it refuses `server.js:157`, `527`, `540`, `545`, `549`, `566`,
  `580`, `584`, `608`, `643`, `710`, `754`, `924`, `940`, `943`, `1074`,
  `1110`, `1163`, `1164`, `1635`, the closures at `675`, `925`, `1070`,
  `1442`, `1477`, `wire-outputs.js:777`, `1128`, `1142`, `outputPartsReady`,
  `let sourcePreparation`, `encodeMetadataRequests` and the `outputParts.`
  count

### Requirement: The source preparation's reads have an owner

The source preparation's `inspect` port and native map publication SHALL move
to `services/server/PreparationReads.js`: `class PreparationReads` with
`inspect(work, preparation)` and `publishNative(work, preparation)`, its ports
those of design.md §6.5 A, importing nothing.

#### Scenario: Preparation reads keep their answers

- **WHEN** `preparation-reads.test.js` calls `inspect(work, preparation)` with
  fake ports for each work kind the closure handled
- **THEN** each answer and each call to `maps.metadata`, `maps.native` and
  `record` is the one the closure made

### Requirement: The forwarded-response log has an owner

The forwarded-response hooks and their request starts SHALL move to
`services/server/forwarded-response-log.js` as `installForwardedResponseLog(app,
{ log, warn, now })`, registered where `server.js:187` registered them.

#### Scenario: The same log lines

- **WHEN** `forwarded-response-log.test.js` injects a forwarded session request
  into a Fastify app with the log installed
- **THEN** the `[forecast-http]` and `[http-response]` lines are those
  `server.js:187-214` wrote

#### Scenario: Other requests

- **WHEN** a request without `x-ttv-forwarded-request-id` is injected
- **THEN** nothing is logged

### Requirement: The work-tags line has an owner

The once-per-file work-tags line SHALL move to `services/media/WorkTagsReport.js`
as `class WorkTagsReport` with `note(address, label, result)`.

#### Scenario: Work tags once per file

- **WHEN** `note({ sourceKey: "src", fileIndex: 0 }, "film.mkv", result)` is
  called twice with results that are neither `pending` nor `needs-ranges`
- **THEN** `log` is called once, with `container metadata "film.mkv": ` followed
  by `describeWorkTags(result)`

#### Scenario: Work tags not yet read

- **WHEN** `note` is called with a `needs-ranges` result and then with a
  `result`
- **THEN** `log` is called once, for the `result`

### Requirement: The admission's addresses have an owner

The admission's prepared and watched addresses SHALL move to
`services/viewer/watched-addresses.js` as `preparedAddresses(viewers,
outputs)` and `watchedAddresses(viewers, outputs, finished)`.

#### Scenario: Watched addresses

- **WHEN** two outputs share an address, one finished and one watched by a
  present viewer
- **THEN** `watchedAddresses` holds that address once

### Requirement: The download share's files have an owner

The share's grouping by file SHALL move to `watchedFiles(outputs, { watched,
lengthOf, encodeCostOf })` in `services/storage/processor-share.js`. The
ports SHALL be arrows in `applyDownloadShare`: `watched` reads
`viewers.forOutput(output).size`, `lengthOf` reads `file.lengthBytes` or
`hostLoad.fileLengthByKey`, `encodeCostOf` reads
`encodeCost.loadOfOutput(outputKey).costSec` for a signallable, unsuspended run.

#### Scenario: Watched files

- **WHEN** two watched outputs read one file and `encodeCostOf` returns 2 for
  each
- **THEN** `watchedFiles` returns one file with `encodeCostSec: 4`

#### Scenario: The first output's length

- **WHEN** two watched outputs of one file give `lengthOf` 1000 and 2000 and
  the file lasts 10 s
- **THEN** its `bytesPerFilmSecond` is 100

#### Scenario: An unwatched output

- **WHEN** `watched` is false for the only output of a file
- **THEN** that file is not returned and `lengthOf` is not asked of it

### Requirement: The startup measurements have an owner

`server.js:286-382` SHALL move to `measureHost({ ffmpegBin, logger,
transcode, processorCores, measures })` in `services/encode/measure-host.js`,
resolving `{ videoEncoder, decodeCostModel, contentionPenalties, calibration,
copySpeedX, audioCalibration, startStopCost, tonemapSupported }` with the same
awaits in the same order; `measures` defaults to the real functions.

#### Scenario: The order of measures

- **WHEN** `measureHost` runs with fake measures and `transcode: true`
- **THEN** they are called in the order of `server.js:286-382`

#### Scenario: Software fall-back

- **WHEN** detection gives a device whose calibration has no modes
- **THEN** `videoEncoder` is the software descriptor and the `calibration:`
  warning is logged

#### Scenario: Nothing to measure

- **WHEN** `transcode` is false
- **THEN** no measure is called and the results are `null`, `[]` and `false`
  as before

### Requirement: The subtitle walk has an owner

`heldFileFor`, `pushFreshCues` and the `SubtitleOrchestrator` construction
(`server.js:393-404`, `422-512`) SHALL move to `class SubtitleWalk` in
`services/media/SubtitleWalk.js`, with the ports `torrents`, `containers`,
`paramsFor`, `wantedSeconds`, `publish`, `log` and `warn`.

#### Scenario: A held file

- **WHEN** the fake pool knows a torrent whose file 0 has 1000 bytes
- **THEN** `heldFileFor("src", 0)` gives `length: 1000` and reads through the
  pool; an unknown torrent or an empty file gives `null`

#### Scenario: One walk at a time

- **WHEN** `pushFreshCues` is called three times while a walk runs
- **THEN** one more walk runs after it, and no other

### Requirement: The torrent-pool ports have an owner

The torrent-pool adapters of the `wireOutputs` call SHALL move to
`torrentPoolPorts({ torrentPool, sourceRegistry, wholeFilesRoot })` in
`services/server/torrent-pool-ports.js`, importing nothing, and be spread into
the `wireOutputs` options.

#### Scenario: Missing claimants

- **WHEN** the pool has no `allowSpillBytes`, `allowWholeFileBytes` or
  `allowMemoryBytes`
- **THEN** `spillDisk`, `wholeFiles` and `memoryClaimant` are `null`

#### Scenario: Stats of an unknown source

- **WHEN** `getSourceStats` is asked for a source with no record, or the pool
  throws
- **THEN** it resolves `null`

### Requirement: The documents name every owner

`docs/layout.md` SHALL say what remains in `server.js` and name each new module
with its component. `docs/download-architecture.md` SHALL place the segment →
bytes projection in `PlaybackResolution`, and `docs/encode-architecture.md`
the encoder input in `EncodeInputResolution`.

#### Scenario: Owners named

- **WHEN** `docs/layout.md` is searched for `segment-reading.js`,
  `SegmentSourceRanges.js`, `PlaybackResolution.js`, `MediaReadParams.js`,
  `EncodeInputResolution.js`, `start-playback.js` and `PreparationReads.js`
- **THEN** each is found beside its component
