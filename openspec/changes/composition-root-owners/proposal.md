# Proposal: Give the logic in the proxy composition root its owners

## Why

`server.js` is described as a composition root, but about 600 of its 1805
lines are algorithms with their own state inside the `startProxyServer`
closure: the download-map pass (`resolvePlayback`, `server.js:675-904`), the
media read parameters with metadata demand per `AbortSignal` (`containerOver`,
`server.js:925-1023`) and the encoder input (`resolveEncodeInput` and
`stretchCopied`, `server.js:1071-1203`). Track selection and the chain
`tracks → media-info → source-navigation → source-ranges | packets` are written
twice; `DownloadMaps` and the output graph are tied by late binding
(`outputPartsReady`, `let sourcePreparation`); none of it is under a biome layer
rule and none of it is tested — `download-maps.test.js` stubs
`resolvePlayback`. Since 2026-05-01 fix commits touched `server.js` 50 times,
all of the latest 25 inside `startProxyServer` (torrent-tv/meta#270).

## What Changes

Code is moved verbatim with injected ports first, tested where it lands, and
deduplicated only after that. Every new owner is a module under an existing
layer rule and has a test under `test/no-torrent/` written from this change
before the code exists.

- **#271** `services/media/segment-reading.js`: the one rule for which tracks a
  segment reads and the interval it states (`selectTracks`, `readingInterval`,
  `segmentReading`, `trackFor`). Both call sites, and the soundtrack lookup in
  `stretchCopied`, use it.
- **#272** `services/media/SegmentSourceRanges.js`: the chain from a file's
  tracks to a segment's source byte ranges, with the `rangesKey` cache, over
  `direct-segment-input.js`, `SegmentInputs.js` and the orchestrator's
  `inspect`/`known`.
- **#273** `services/torrent/PlaybackResolution.js`: the download-map pass —
  projections, segment records, grids, made rates, pass costs, the refresh
  after a packet table, the turns it yields and every `map.isCurrent()` check.
  `wire-outputs.js` builds the `playedOutputsOf(sourceKey, fileIndex)` port it
  reads.
- **#274** `services/server/MediaReadParams.js`: media read parameters and the
  metadata demand kept for as long as the request's signal.
- **#275** `services/encode/EncodeInputResolution.js`: the encoder's input and
  the soundtrack walk from a picture's copy; `wireOutputs` receives this one
  object instead of two closures.
- **#276** The output graph is built first; `wireOutputs` announces viewer
  changes on `viewerChanges`; `services/server/start-playback.js` subscribes
  the maps and the preparation and only then adopts what an earlier process
  left. No `outputPartsReady`, no `let sourcePreparation`.
- **#277** `test/no-torrent/composition-root-states-no-facts.test.js` refuses
  collection constructors and closures longer than 40 lines in `server.js` and
  `wire-outputs.js`. The code it would refuse today moves to owners:
  `services/server/PreparationReads.js` (the source preparation `inspect` port),
  `services/server/forwarded-response-log.js`, `services/media/WorkTagsReport.js`,
  `services/viewer/watched-addresses.js` and `watchedFiles` in
  `services/storage/processor-share.js`.
- **#278** `AGENTS.md`, `docs/download-architecture.md` and
  `docs/encode-architecture.md` name each owner and its layer; the parent's
  criteria are measured and recorded on torrent-tv/meta#270.

## Capabilities

### New Capabilities

- `segment-reading`: which tracks one segment or run reads, and its interval.
- `segment-source-ranges`: the source byte ranges of one segment interval, and
  the reads of an encoder run's input.
- `playback-resolution`: the download-map pass from map zones to swarm windows.
- `media-read-params`: the parameters of one media read and its metadata
  demand.
- `encode-input-resolution`: the encoder input of one run and the soundtrack
  walk from its copy.
- `composition-root`: what `server.js` and `wire-outputs.js` may contain, the
  start order, and where the moved pieces are documented.

### Modified Capabilities

None. No observable behaviour changes.

## Impact

- New: the modules named above and one test file per owner under
  `test/no-torrent/`; a temporary equivalence test for #273, removed after it
  is merged.
- Changed: `server.js`, `services/server/wire-outputs.js` (`playedOutputsOf`,
  `viewerChanges`, `encodeInputResolution` option replaces `resolveEncodeInput`
  and `stretchCopied`, `onViewerChanged` option removed),
  `services/storage/processor-share.js`, `AGENTS.md`, the two architecture docs.
- `biome.json`: unchanged. Every new file falls under an existing rule without
  a new exception; the `wire-outputs.js` exception stays, because that file is
  the assembler and imports components by design.
- Commits are `refactor(proxy)`, `test(proxy)` and `docs(proxy)`; nothing is
  released.

## Non-goals

- No behaviour change: the same windows, ranges, encoder inputs, metadata
  demand and the same order of reads and awaits.
- No release, no `CHANGELOG.md` entry (no log line changes).
- The wait-trace P4.1 schema (event fields, outcomes, method names) and the
  `download map passes … longest Nms` log line stay byte-for-byte as they are.
- Not in scope: the startup host measurements (`server.js:283-382`), the
  subtitle walk wiring (`server.js:393-512`) and the torrent-pool claimant
  adapters passed to `wireOutputs`. Without moving them `server.js` stays at
  about 1150-1200 lines, above the parent's "< 900" (see design.md, "Parent
  criteria").
