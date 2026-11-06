# Proposal: Solve each recurring task one way

## Why

The question asked of the codebase (torrent-tv/meta#279): is the same task
solved the same way everywhere, or several ways? A token clone scan
(8-line windows of normalised source) finds almost no copy-paste in proxy
source — eight pairs of 8-15 lines — so the duplication is re-implementation
of one idea, not copied text. Five read-only audits (proxy cross-cutting,
proxy domain, proxy HTTP and tests, server and page, tooling across
repositories) found about 60 cases. Where copies disagree the product behaves
differently by path; these were re-checked by reading the code:

- `utils/parse-range.js` reads `bytes=-500` as bytes 0-500 and lets
  `/stream` answer an unsatisfiable range with the whole file, while
  `routes/media/get.js` parses the same header correctly (#282).
- `torrent-pool.js` `fileDownloadedBytes` subtracts a whole piece when a file
  ends on a piece boundary; nine other places convert bytes to pieces outside
  `torrent/demand/pieces.js`, the owner AGENTS.md names (#283).
- An FMP4/M4S2/MP4S AVI is MPEG-4 to `AviContainer` and `h264` to
  `decodeFamilyOf`, because two codec tables differ (#284).
- `OutputTimes` means to stop one misplaced run and `stopEncodeRun` stops
  every run of the output (#286).
- The tunnel relay forwards any path to loopback without the data channel's
  allowlist, so `/encode-input` and `/media` pass their loopback check
  (#281).
- The page releases the picture after a seek on a missing forecast and waits
  on it at start (server, #289).

## What Changes

Forty sub-issues of #279, each converging one task on one owner, in Priority
16.01-16.40 (after the forecast series #255-#266). Proxy-side:

| # | Task | Owner after the change |
|---|------|------------------------|
| #281 | forward a relayed request to loopback | `services/transport/loopback-forward.js`; tunnel relay deleted |
| #282 | parse and answer byte ranges | `utils/parse-range.js` (RFC 9110), `services/server/byte-range-reply.js` |
| #283 | bytes → pieces, range union | `torrent/demand/pieces.js`, `utils/byte-ranges.js` |
| #284 | codec names | `media/tracks/codec-names.js` |
| #285 | bit reader, RBSP, AAC config | `media/container/bitstream.js` |
| #286 | stop one run | run-level stop beside `stopEncodeRun` |
| #291 | run ffmpeg/ffprobe, parse `-progress` | one runner, one progress parser |
| #292 | read CPU, cores, free disk | `services/storage/` |
| #293 | resolve options, write state files | `bin/cli.js`; one atomic JSON write |
| #294 | median, byte units | `utils/median.js`, `utils/units.js` |
| #295 | read request fields, notice a departed requester | `services/server/http-fields.js`, `requester-gone.js` |
| #296 | refusal and pending answer shapes | `services/server/http-responses.js` |
| #305 | log ports, loop delay, rotation | `utils/logger.js` shape, `utils/perf.js` |
| #306 | WebTorrent internals | the worker-side adapter |
| #307 | coalesce, abort race, yield | `utils/coalesce.js`, abort helper, `takeTurns` |
| #308 | route → domain, twin routes | injected controllers, one handler per twin |
| #309-#311 | test fixtures, waits, route harness | `test/no-torrent/helpers/` |
| #316 | clock rule | `utils/clock.js` + passed-in clocks |
| #317-#318 | not-yet / forgotten / cancelled outcomes; forgetting a source | one outcome form; one registration |
| #319 | viewer demand and native-source zones | `PriorityMap` builder, `SegmentInputs` |
| #320 | output rate, encoder speed | one produced-rate function; `EncodeCost` speed |

Server and tooling sub-issues (#287-#290, #297-#304, #312-#315) are listed in
`design.md`; the server's own notes are in
`server/openspec/changes/one-way-per-task/`.

## Capabilities

### New Capabilities

- `one-way-per-task`: each recurring task named here has one owner, and a
  check refuses a second copy where a check is practical.

### Modified Capabilities

None as a whole. Individual sub-issues change behaviour where copies
disagreed; each says so and adds a `CHANGELOG.md` entry.

## Impact

Code across `services/`, `routes/`, `utils/`, `bin/cli.js`, `test/no-torrent/`
and CI files of all repositories, spread over 40 independent changes.
`server.js` is touched only where #270-#278 do not, or after them.

## Non-goals

- The `server.js` composition-root duplication (track selection and the
  `tracks → media-info → source-navigation → source-ranges` chain): #270-#278.
- The forecast mathematics: #255-#266. Copies inside forecast code are noted
  and left to that series.
- Removing OpenSpec: it holds these notes.
