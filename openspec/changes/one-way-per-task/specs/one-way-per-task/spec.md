# one-way-per-task — delta spec (proxy)

Each requirement names one task, its one owner and the check that refuses a
second copy. The sub-issue in brackets carries the steps and acceptance
criteria.

## ADDED Requirements

### Requirement: Relayed requests reach loopback through one function (#281)
The proxy SHALL forward a request that arrived from outside to its own HTTP
server only through `services/transport/loopback-forward.js`, which applies
the path allowlist, the body cap, cancellation and the dispatcher without
header/body timeouts.

#### Scenario: A path outside the allowlist
- **WHEN** a relayed request names `/encode-input/1/0` or `/media`
- **THEN** it is refused before any loopback call, whichever transport carried it

#### Scenario: One caller of fetch
- **WHEN** `services/transport` is searched for `fetch(`
- **THEN** only `loopback-forward.js` and `registry-api.js` match

### Requirement: Byte ranges are parsed and answered one way (#282)
`utils/parse-range.js` SHALL be the only parser of the `Range` header and
SHALL follow RFC 9110 for a single range; `/stream`, `/media` and
`/encode-input` SHALL answer an unsatisfiable range with 416 and SHALL keep
the headers set by hooks on every answer.

#### Scenario: Suffix range
- **WHEN** `bytes=-500` is asked of a 1000-byte file
- **THEN** bytes 500-999 are answered with 206

#### Scenario: Past the end
- **WHEN** `bytes=2000-3000` is asked of a 1000-byte file on any of the three routes
- **THEN** the answer is 416 with `Content-Range: bytes */1000`

### Requirement: Bytes become pieces only in pieces.js (#283)
Conversions between bytes and piece numbers SHALL be made by
`services/torrent/demand/pieces.js`; no other file in `services/` SHALL
divide or multiply by a piece length outside a named exemption list.

#### Scenario: A file ending on a piece boundary
- **WHEN** every piece of a file that ends exactly on a piece boundary is held
- **THEN** its downloaded bytes equal its length

### Requirement: One codec name table (#284)
Codec ids and FOURCCs SHALL be named by `services/media/tracks/codec-names.js`.

#### Scenario: MPEG-4 Part 2 under any FOURCC
- **WHEN** an AVI track's FOURCC is any of FMP4, XVID, DIVX, DX50, MP4V, M4S2, MP4S
- **THEN** its codec name is `mpeg4` and its decode family is `mpeg4`

### Requirement: One bit reader and one RBSP rule (#285)
Bitstream parsing in `services/media` SHALL use the bounded reader, the
lenient RBSP removal and the AudioSpecificConfig parser of
`services/media/container/bitstream.js`.

#### Scenario: Emulation prevention followed by a byte above 3
- **WHEN** an AVC slice contains `00 00 03 04`
- **THEN** the elementary index reads it without throwing

### Requirement: A correction stops only the run it means (#286)
The cut-table correction SHALL stop only the run that starts at the corrected
segment.

#### Scenario: Two live runs
- **WHEN** an output has a run near the viewer and a misplaced run and the correction fires
- **THEN** the run near the viewer keeps producing

### Requirement: One process runner and one progress parser (#291)
Short ffmpeg/ffprobe processes SHALL run through one runner; `-progress`
output SHALL be parsed by one parser that carries partial lines and ignores
negative and `N/A` times; ffprobe SHALL be resolved in `bin/cli.js`.

#### Scenario: The INT64_MIN sentinel
- **WHEN** a progress line reads `out_time_ms=-9223372036854775808`
- **THEN** no sample is taken from it

### Requirement: The machine is read in services/storage (#292)
CPU time, core counts and free disk SHALL be read only under
`services/storage/`; other layers SHALL receive the readings passed in, with
host cores and bound cores named apart.

#### Scenario: No second reader
- **WHEN** `services/` outside `storage/` is searched for `/proc/`, `statfs` and `os.cpus(`
- **THEN** only the NVIDIA driver read in `fingerprint.js` matches

### Requirement: Options resolved once, state written atomically (#293)
Operator options SHALL be resolved in `bin/cli.js`; JSON state files SHALL be
written to a temporary file and renamed.

#### Scenario: Interrupted write
- **WHEN** a write stops between the temporary file and the rename
- **THEN** the previous state file is still read whole

### Requirement: One median and one byte formatter (#294)
Medians SHALL be computed by one function (even length averaged, empty →
null, non-finite filtered) or a stated upper-middle choice; bytes and rates
SHALL be printed as decimal MB and MB/s, memory as MiB.

#### Scenario: One rate, one figure
- **WHEN** the swarm download rate is printed by two components in one second
- **THEN** both print the same number with the same unit

### Requirement: Request fields and departure are read one way (#295)
Routes SHALL read request fields through `services/server/http-fields.js`
and notice a departed requester through `services/server/requester-gone.js`.

#### Scenario: Same raw value, same answer
- **WHEN** `fileIndex` is `""`, `"1e2"`, `" 1"`, `null` or `true` on any route that takes it
- **THEN** every route answers it the same way

#### Scenario: Requester gone before the wait began
- **WHEN** the connection closes before a long-wait handler attaches its listener
- **THEN** the wait ends

### Requirement: One shape per refusal (#296)
Obsolete, pending, not-found and retry-later answers SHALL be produced by
`services/server/http-responses.js`, with `canRetry` as the only retryability
field.

#### Scenario: Not found
- **WHEN** any route does not know a source key
- **THEN** it answers 404 with `code: "SOURCE_NOT_FOUND"`

### Requirement: One logger shape and one loop-delay owner (#305)
Components SHALL log through the `ProxyLogger` shape with a level per line,
and main-thread loop delay SHALL be measured only by `utils/perf.js` with
windows per consumer.

#### Scenario: Overlapping windows
- **WHEN** two consumers read loop delay over overlapping intervals
- **THEN** neither resets the other's window

### Requirement: WebTorrent internals are touched in one module (#306)
Private WebTorrent fields and wire request queues SHALL be read or changed
only by the worker-side internals module.

#### Scenario: No other reader
- **WHEN** `services/` is searched for `_buffer`, `wire.requests`, `_selections`, `_critical`, `_markUnverified`, `_startPiece`
- **THEN** only the internals module matches

### Requirement: One coalescer, one abort race, one yield (#307)
Run-again coalescing SHALL use `utils/coalesce.js`; racing a wait against an
abort SHALL use one helper with one rejection value; long work SHALL yield
through `takeTurns` or a passed-in turn function.

#### Scenario: A second caller during a run
- **WHEN** a coalesced job is asked again while it runs
- **THEN** the second caller's promise settles when the rerun ends

### Requirement: Routes reach the domain one way (#308)
Routes SHALL receive controllers or services built once and injected; twin
routes SHALL share one handler.

#### Scenario: No per-request construction
- **WHEN** `routes/` is searched for `await import(` and `new …Controller`
- **THEN** nothing matches

### Requirement: Tests build fixtures through shared helpers (#309, #310, #311)
Proxy tests SHALL build managers, outputs, Renditions hosts, container bytes,
waits, source-text reads and route apps through `test/no-torrent/helpers/`.

#### Scenario: No private store root
- **WHEN** `test/no-torrent/*.test.js` is searched for `wireOutputs(`
- **THEN** nothing matches

### Requirement: One clock rule (#316)
Durations within a thread SHALL use monotonic time; instants that cross a
thread or process, are persisted, or are compared with the browser SHALL use
one epoch form.

#### Scenario: A capture from a worker thread
- **WHEN** a capture made in a `worker_threads` Worker reaches `sourceCaptureOf`
- **THEN** it is accepted

### Requirement: One outcome per event and one forget (#317, #318)
"Bytes not yet", "source forgotten" and "cancelled" SHALL each have one form
at component boundaries; forgetting a source SHALL reach every owner through
one registration, `ContainerOrchestrator` included.

#### Scenario: Forgotten source
- **WHEN** a source is forgotten while reads are in flight
- **THEN** every asker receives the same outcome and no owner keeps an entry for it

### Requirement: One viewer demand (#319)
A viewer's demand and pause attenuation SHALL be built by one function from
`PriorityMap.js`, and native-source zones SHALL use `SegmentInputs`.

#### Scenario: Hidden tab
- **WHEN** a viewer's tab is off screen
- **THEN** the same attenuation applies to its output map and its native-source map

### Requirement: One output rate and one encoder speed (#320)
An output's produced rate and prior rate SHALL each be computed in one place;
encoder speed SHALL be read through one `EncodeCost` method that names
measured, predicted and aggregate.

#### Scenario: Copied picture with several soundtracks
- **WHEN** a copied 1080p file has three AC-3 soundtracks
- **THEN** both former paths give the same prior rate
