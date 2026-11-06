# media-read-params Specification

## Purpose
One module makes the parameters of a media read and keeps the metadata demand for as long as the request's signal, instead of that logic living in the server closure.

## Requirements

### Requirement: One owner makes the parameters of a media read

`services/server/MediaReadParams.js` SHALL export `class MediaReadParams` with
`async paramsFor({ sourceKey, fileIndex, requestId, packetInterval, demand,
readPriority, signal })`, constructed with the ports `heldFile`,
`packetMemory`, `readProbe`, `probePackets`, `baseUrl`, `observeWait`,
`reads`, `maps`, `learnKeyframes`, `formatOf` and `warn`. It MUST import
nothing and MUST pass the `services/server/*.js` lint rule.

#### Scenario: The layer rule holds

- **WHEN** `npx biome lint` runs
- **THEN** `services/server/MediaReadParams.js` passes

#### Scenario: No file

- **WHEN** `heldFile` returns `null`
- **THEN** `paramsFor` resolves `null` and registers nothing on the signal

### Requirement: server.js keeps no media read state

`server.js` MUST contain no `containerOver` and no `encodeMetadataRequests`,
and SHALL call `mediaParams.paramsFor` wherever it called `containerOver`.

#### Scenario: Nothing left in server.js

- **WHEN** `server.js` is read after #274
- **THEN** it contains neither `encodeMetadataRequests` nor `containerOver`

### Requirement: The parameters are those the reads used before

`paramsFor` SHALL resolve a new object with, in this order, `sourceKey`,
`fileIndex`, `requestId`, `signal`, `packetInterval`, `readPriority`,
`packetMemory`, `downloadInterval`, `readRange`, `fileSize`, `probe`, `label`,
`fileOffset`, `onObserved`, `onTracks`, `onReadStart`, `onReadResult` and
`portionBytes`. Fields of its argument other than the seven named SHALL be
ignored.

#### Scenario: The fields

- **WHEN** `paramsFor({ sourceKey: "src", fileIndex: 0, demand: { from: 4, to:
  8 }, zones: [] })` resolves
- **THEN** `Object.keys(params)` is that list, `downloadInterval` is `{ from:
  4, to: 8 }`, `fileSize`, `label`, `fileOffset` and `portionBytes` come from
  `heldFile`, and there is no `zones` key

#### Scenario: A read past the end is cut

- **WHEN** `params.readRange(900, 5000)` is called on a 1000-byte file
- **THEN** `heldFile`'s `readHeld` receives `(900, 999)`

### Requirement: The probe reads the proxy's own media route

`params.probe(statement, onRecord)` SHALL call `readProbe` with the statement
`` `ffprobe:${statement}` `` and a `probe({ requestId, signal })` that calls
`probePackets` with the string URL of `/media` on `baseUrl()` with
`sourceKey`, `fileIndex` and `readId` set in that order.

#### Scenario: The probe URL

- **WHEN** `baseUrl()` returns `http://127.0.0.1:9000`,
  `params.probe("keyframes", onRecord)` is called for file 0 of `src`, and
  `readProbe` calls the given `probe({ requestId: "r1", signal })`
- **THEN** `readProbe` received `statement: "ffprobe:keyframes"` and
  `probePackets` received, as a string and not a `URL`, `url`
  `http://127.0.0.1:9000/media?sourceKey=src&fileIndex=0&readId=r1`,
  `statement: "keyframes"`, that `signal` and `onRecord`

### Requirement: What a read observes is reported

`onObserved(fields)` SHALL write two `process` events through `observeWait`:
`phase: "begin"` at `askedAt`, then `phase: "end"` at `endedAt` with
`startedAt` and `endedAt`, each with `process` (`P5` for `keyframes`, `X1` for
`ffprobe:…`, else `P2`), `fileIndex`, `requestId` and the read's fields.
`onTracks` SHALL tell `noteVideo` whether any track is video, and
`onReadStart` SHALL return the read revision.

#### Scenario: Observed keyframes

- **WHEN** `params.onObserved({ statement: "keyframes", askedAt: 1, endedAt: 3
  })` is called
- **THEN** `observeWait` receives `process: "P5", phase: "begin", at: 1` and
  then `phase: "end", at: 3, startedAt: 1, endedAt: 3`

#### Scenario: The other processes

- **WHEN** the statement is `ffprobe:keyframes`, then `tracks`
- **THEN** `process` is `X1`, then `P2`

#### Scenario: Tracks state whether the file has a picture

- **WHEN** `params.onTracks([{ type: "audio" }])` is called
- **THEN** `heldFile`'s `noteVideo` receives `false`

#### Scenario: The read revision

- **WHEN** `params.onReadStart()` is called
- **THEN** it returns `{ storage: reads.revision(sourceKey, fileIndex),
  memory: reads.memoryRevision(), demand: maps.epoch(sourceKey, fileIndex) }`

### Requirement: A read result counts only while it is still wanted

`onReadResult(statement, result, revision)` SHALL return without effect when
`revision.demand` differs from `maps.epoch(sourceKey, fileIndex)`, or when a
`demand` was given and `maps.wantsInterval(sourceKey, fileIndex, demand)` is
false.

#### Scenario: An older demand

- **WHEN** `maps.epoch` returns 8 and `revision.demand` is 7
- **THEN** neither `reads.record` nor `maps.metadata` is called

#### Scenario: An interval no longer wanted

- **WHEN** a `demand` was given and `maps.wantsInterval` returns `false`
- **THEN** neither `reads.record` nor `maps.metadata` is called

### Requirement: A wanted result is learned, recorded and refreshed

`onReadResult` SHALL learn keyframes from a `keyframes` result, then record the
result with `reads.record`, then state or withdraw the metadata demand. When
the record says the read finished with a result, it SHALL call
`maps.refresh(sourceKey, fileIndex)` without awaiting it and warn `download
map source=… file=… metadata refresh failed: …` if that rejects.

#### Scenario: Keyframes learned

- **WHEN** `onReadResult("keyframes", { kind: "result", value: { times: [0,
  2], tolerance: 0.1 } }, revision)` is called and `formatOf` returns `"avi"`
- **THEN** `learnKeyframes` receives the params object itself and `{ times:
  [0, 2], tolerance: 0.1, format: "avi" }`

#### Scenario: Refresh after a finished read

- **WHEN** `reads.record` returns `true` for a `result`
- **THEN** `maps.refresh(sourceKey, fileIndex)` is called once

#### Scenario: No refresh while ranges are needed

- **WHEN** `reads.record` returns `true` for a `needs-ranges` answer
- **THEN** `maps.refresh` is not called

### Requirement: Passive chapters withdraw their demand

A `chapters` result with `passive: true` SHALL await
`maps.withdrawMetadata(sourceKey, fileIndex, "chapters")` instead of stating
metadata.

#### Scenario: Chapters passive withdrawal

- **WHEN** `onReadResult("chapters", { kind: "result", passive: true },
  revision)` is called
- **THEN** `maps.withdrawMetadata` receives `(sourceKey, fileIndex,
  "chapters")` and `maps.metadata` is not called

### Requirement: The metadata demand names its origin

Otherwise `onReadResult` SHALL await `maps.metadata` with `statement`
`` `${statement}:${requestId}` `` (or `statement` without a request id), the
`result`, and the fields of `server.js:1006-1013`: `chapters` defaults, then a
viewer `demand`, then an encode or preparation `readPriority`, and `owner:
"file"` when there is neither.

#### Scenario: A file's own read

- **WHEN** neither `demand` nor `readPriority` was given
- **THEN** `maps.metadata` receives `owner: "file"` and no `scope`

#### Scenario: A viewer's interval

- **WHEN** `demand` is `{ from: 4, to: 8, priority: 70, urgent: true,
  deadlineAt: 5000 }`
- **THEN** `maps.metadata` receives `priority: 70, urgent: true, deadlineAt:
  5000, interval: demand, leadSeconds: 0`

#### Scenario: An encode input read

- **WHEN** `readPriority` is `{ requestId: "enc-1", rank: 40, urgent: true,
  deadlineAt: NaN }` and the statement is `packets`
- **THEN** `maps.metadata` receives `statement: "packets:enc-1"`, `priority:
  40`, `urgent: true`, `deadlineAt: Infinity`, `scope: "preparation"`

#### Scenario: Chapters of the file

- **WHEN** the statement is `chapters`, not passive, with neither demand nor
  read priority
- **THEN** `maps.metadata` receives `priority: 1, urgent: false, deadlineAt:
  null, owner: "file"`

### Requirement: The metadata demand lasts as long as the request's signal

With `readPriority.requestId` and `signal`, `paramsFor` SHALL keep one tracker
per signal and file. A `needs-ranges` result SHALL add its metadata statement
to it, any other result SHALL remove it. On abort the tracker SHALL call
`maps.withdrawMetadata` for each statement held, warning `encode input demand
withdrawal failed: …` on failure, and forget itself; an aborted signal SHALL
withdraw at once.

#### Scenario: Demand withdrawn on abort

- **WHEN** a `packets` read answered `needs-ranges` for request `enc-1` and the
  signal aborts
- **THEN** `maps.withdrawMetadata` receives `(sourceKey, fileIndex,
  "packets:enc-1")` exactly once

#### Scenario: needs-ranges tracked and released

- **WHEN** the same statement answered `needs-ranges` and then `result` before
  the signal aborts
- **THEN** aborting withdraws nothing

#### Scenario: One tracker per signal and file

- **WHEN** `paramsFor` is called twice with the same signal and file and each
  read answers `needs-ranges` for a different statement
- **THEN** one abort withdraws both statements and the signal has one abort
  listener for that file

#### Scenario: An aborted signal

- **WHEN** `paramsFor` is called with a signal already aborted
- **THEN** no abort listener is added to it and `maps.withdrawMetadata` is not
  called

#### Scenario: Without a request id

- **WHEN** `signal` is given without `readPriority.requestId`
- **THEN** no abort listener is added
