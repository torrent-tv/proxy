# Proxy layout — modules and their owners

Which module lives where and what it owns. This page owns the module list; the
seven components, their duties and how they talk are in
[`component-architecture.md`](component-architecture.md), and the rules every
change must keep are in [`../AGENTS.md`](../AGENTS.md). What each directory may
import is enforced by the `overrides` in `biome.json`.

## Entry and composition

- `bin/cli.js` — CLI entry. Resolves `ffmpegBin` (`--ffmpeg-bin`, else the
  bundled `ffmpeg-static`, else `ffmpeg` on `PATH`), chooses `ffprobeBin` once
  before `startProxyServer` (`services/media/ffprobe-selection.js`; a host with
  no qualifying ffprobe stops with `FfprobeUnavailableError`), and hands `transport/` the
  memory reading and the rule for which captures are kept. `bin/thread-pool.js`
  sets the size of libuv's thread pool before anything blocks on it.
- `server.js` — the composition root. Creates Fastify and its hooks (through
  `services/server/forwarded-response-log.js`), initialises process-wide
  resources and the torrent pool, calls `measureHost`
  (`services/encode/measure-host.js`) and `services/server/wire-outputs.js` for
  the output and encode graph, constructs every owner with its ports, runs the
  start order in `services/server/start-playback.js`, registers each route and
  calls `listen`.
- `services/server/wire-outputs.js` — the subordinate assembler of the output
  and encode graph. It does not create the HTTP server or register routes. It
  exposes `parts.viewerChanges` (emits `"change"` when a viewer changes) and
  `parts.playedOutputsOf(sourceKey, fileIndex)` (the outputs a present viewer
  plays, with their timeline, choices and segment sizes).

## Routes

`routes/<path>/<method>.js`, one folder per URL path and one file per method,
the same convention as the server repository. Routes translate HTTP to a
controller call and depend on controllers, not services. Examples:

- `routes/stream/get.js` — byte-range streaming of a torrent file (HTTP 206).
- `routes/api/playback-plan/post.js` — the playback plan of a file.
- `routes/transcode/session-file/get.js` — HLS playlist, init and segments. A
  segment that is not ready is held as long as the requester states
  (`X-Hold-Ms`).

The request and response fields the page relies on:
[`browser-proxy-contract.md`](browser-proxy-contract.md).

## `services/media/`

- Domain: `media/container/` and `media/tracks/`.
  - `media/container/` — `Container` (abstract), `ContainerFactory` (sniffs the
    signature bytes and picks the class: `MatroskaContainer`, `Mp4Container`,
    `AviContainer`, `MpegTsContainer`, `MpegPsContainer`, `AsfContainer`;
    `FfprobeContainer` for other formats when a strict probe reader is given;
    `SubtitleFileContainer` for a plain subtitle document), `KeyframeTable`,
    `ebml-reader.js` (the byte-level grammar of EBML), `unavailable.js`
    (`BytesUnavailable`, the strict read). Everything a container states about
    itself lives in its own class: track table, Cues, cluster positions, blocks
    inside a cluster, the MP4 sample table, and the walk of what is downloaded
    (`MatroskaContainer.readHeldCues` over `matroska-clusters.js`, which also
    finds clusters the Cues table does not name; `Mp4Container.readHeldSamples`).
    `ContainerFactory` is the one place that decides what a file is.
  - `media/tracks/` — `ContainerTrack` → `VideoTrack` / `AudioTrack` /
    `SubtitleTrack` → `TextSubtitleTrack` / `ImageSubtitleTrack`. Where a
    track's bytes are (inside the file or in a sidecar) is not a kind of track
    and is not known here (`tracks/index.js`). Flags follow the specs:
    FlagForced only on subtitles (RFC 9559 §5.1.4.1), FlagOriginal and
    FlagCommentary only on audio, MP4 `tkhd` track_enabled and alternate_group,
    `elng` as BCP 47.
- Application files beside them:
  - `ContainerOrchestrator` — detection and the one container per file
    (`containerFor`, `getTracks`, `getMediaInfo`, `getKeyframeIndex`). The
    container keeps its own reading of each element once read.
  - `KeyframeTables` — the only store of a file's keyframe answer and the only
    reader of one. The table (`container/KeyframeTable.js`) is one object per
    file, handed out rather than copied, so a read that lands after a session
    was made still reaches it. It separates `answered` (a reader came back) from
    `readable` (it came back with times): a file that must always be re-encoded
    is not confused with a passing shortage of bytes. One read per file, a
    second asker joins the first, and a read that threw (`BytesUnavailable`
    included) is not recorded; it is read again when pieces of the file arrive
    (`readAgainIfUnanswered`). The second reader is the packet probe
    (`probe-packets.js`, packet records through ffprobe); the fuller answer
    stands (`KeyframeTable`).
  - `SubtitleOrchestrator` — the track list and the cues behind `Container`
    tracks. It is handed the cue reading; it does not import torrent code.
  - `SubtitleCues` (the plan, the found-order cursor, one walk of a file at a
    time, withdrawn cues) and `SubtitleWalk` (the walk over held bytes that
    pushes new cues to viewers; every free variable is a port).
  - `playback-planner.js` — the playback plan from the file's shared container
    declarations (`playback-declarations.js`). `mode` is advisory; the browser
    decides per track.
  - `segment-reading.js` (what a segment reads: `trackFor`, `selectTracks`,
    `readingInterval`, `segmentReading`; pure), `SegmentSourceRanges.js` (the one
    resolver of a segment's source byte ranges, forgotten with its source),
    `WorkTagsReport.js` (the work-tags log, once per file), `ChapterOrchestrator`,
    `audio-inventory.js`, `ffmpeg-banner.js`, `ffprobe-selection.js` (the one
    owner of which ffprobe binary is used: the first candidate, the bundled one
    then `ffprobe` on `PATH`, whose `-sections` names `stream_side_data`;
    `probe-packets.js` takes the chosen binary and never picks one).

## `services/torrent/`

- `torrent/demand/` — what anybody wants, in bytes: `Window` (claimant, file,
  byte range, urgency), `Urgency` (BLOCKED / NEAR / AHEAD / TAIL / BEHIND),
  `DemandRegister` (live windows by claimant), `pieces.js` (the one place bytes
  become piece numbers). No WebTorrent and no piece store.
- `torrent/download/` — `SwarmSelection`, the only caller of `select`,
  `deselect` and `critical`; `registry.js`, one selection per torrent and the
  cross-torrent rule that withholds the speculative levels while anything urgent
  is missing anywhere; `TailRepeat`, the bounded late-tail decision for
  `requiredPieces()`. See [`download-architecture.md`](download-architecture.md).
- `torrent/worker/` — the torrent thread, assembled in `worker.js`, which hands
  `torrent/` the piece store's class. `held-bytes.js` lists which ranges of a
  file are held whole and reads them without fetching (an answer with nothing
  where a range is not whole). `WebTorrentTailRepeatAdapter` is the only live
  code that reads private piece buffers or wire request queues, or changes
  reservations, for the late-tail exception.
- `torrent/PlaybackResolution.js` — the segment → bytes projection of a played
  file, handed to `viewer/DownloadMaps` as `resolvePlayback`; reads
  `segment-reading.js` and `SegmentSourceRanges.js` through ports.
- `torrent/piece-store-of.js` — reaches the piece store by what it does;
  `torrent/Contents.js` — what a torrent contains (handed to the planner).

## `services/encode/`

- `encode/output/` — domain: `OutputSpec`, `VideoOutput`, `AudioOutput`,
  `CutGrid` (all in `OutputSpec.js`), `OutputRetention` (unused period and
  removal order), playlists and the ladder. What a session produces — which
  tracks, in what form, cut and packaged how — and therefore its identity: two
  outputs whose parameters agree are the same output and its result is reused.
  Nothing about a viewer, and nothing about a request that does not change a
  byte of the result. `server/ViewerRequests.js` builds the spec and keys the
  output on it.
- `EncodePlan` — the one authority on where encoders go
  ([`encode-architecture.md`](encode-architecture.md)).
- `OutputOpening` (which output answers a request, made if absent, without
  knowing who asked), `EncodeRuns` (build a run where the plan places it,
  follow it, account for its end and its input), `EncoderSelection` (encoder in
  use and the move to software), `Renditions` (picture steps, soundtracks,
  master playlist, which rung a page plays), `OutputTimes` (where each segment
  begins and how the cut table is corrected), `CushionReport` (film ready in
  front of the viewers), `output-key-format.js`, `EncodeInputResolution.js`
  (original input or packets, and the soundtrack walk; imports nothing),
  `measure-host.js` (startup host measurements, only with transcoding on).
- `encode/quality/` — quality control, encode cost, `ColdStarts`.
- `encode/segment-formats/` — fMP4 and MPEG-TS behind one interface, including
  the `tfdt` rewrite of fMP4 fragments.
- `encode/hwaccel.js` — hardware encoder detection (NVENC, QSV, VAAPI,
  V4L2M2M) with the strict startup test.

## `services/viewer/`

Every viewer has a name (`Viewers.of` refuses an empty one). A quality request belongs to one viewer and exists only in
AUTO (`Viewer.askQuality`). The playback start forecast
(`playback-readiness.js`) is the viewer's; `ViewerRequests` is handed it by
`wire-outputs.js`. `media-time.js` is exact media time and the rule by which
Media Source engines join buffered ranges
([`playback-start-forecast.md`](playback-start-forecast.md)).
`PriorityMap` and `DownloadMaps` turn viewers into the download map;
`watched-addresses.js` holds prepared and watched addresses.

## `services/storage/`

One component in four places, because the holders differ in lifetime, address
and thread:

- `storage/piece-store/` — the torrent's pieces: memory tier, spill tier and the
  order they leave in (`shared-piece-store.js`, `piece-lru.js`,
  `piece-disk-store.js`). Torrent worker thread.
- `storage/segment-store/SegmentStore.js` — segments an encoder produced,
  addressed by the output key. Main thread. It keeps bytes and executes
  publication and deletion but owns no idle or eviction policy: that is
  `encode/output/OutputRetention`, applied by `server/OutputLifecycle` after it
  coordinates viewer demand, writers and reads. Whether a piece is whole is
  decided by `encode/piece-completeness.js`.
- `storage/files/` — files downloaded whole and kept as files
  (`CompletedFiles.js`, `piece-from-whole-file.js`). Worker thread.
- `storage/` — the one budget: `MachineBudget.js` (owner), `allowance.js`
  (rule), `machine-memory.js` and `free.js` (read the machine), `wire.js` (the
  claimants and the resource each takes), `keep.js` and `returns.js` (how long
  unused material is kept, `IDLE_KEEP_MS`), `processor-share.js`. It holds no
  bytes.

The four may import each other and nothing else. Policies and lifetimes:
[`storage-architecture.md`](storage-architecture.md).

## `services/server/`

`ViewerRequests` (open an output of a file and be placed on it, state a
position, report progress), `SegmentServing` (answer a playlist, init or segment
from the store, or hold it until the piece is whole, waiting for the store's
publication event), `OutputLifecycle` (dispose an output nobody is on, all at
shutdown, adopt what an earlier process left), `MediaReadParams.js`,
`start-playback.js` (viewer changes are subscribed before segments left behind
are adopted), `PreparationReads.js`, `forwarded-response-log.js` (the
`[forecast-http]` and `[http-response]` hooks), `torrent-pool-ports.js`, and
`controllers/` (`PlaybackController`, `SubtitleController`,
`ChapterController`). Long-lived facts belong to their owners: the init served
for an output to `SegmentStore`, bytes read for an output to `EncodeRuns`, the
cold-start measurement to `ColdStarts`. These modules import no component's
implementation — only the name of an output and its playlist
(`encode/output/index.js`) and the keeping period (`storage/keep.js`).

## `services/transport/`

Tunnel to the server (`tunnel-client.js`, keepalive every 30 s), WebRTC
(`webrtc-manager.js`, one UDP port multiplexed for all sessions),
`data-channel-handler.js` (data-channel requests forwarded to the local HTTP
server through `loopback-forward.js`), `port-mapper.js` (UPnP/NAT-PMP mapping of the TCP and UDP port,
`--no-port-mapping` opts out), `nat-classifier.js`, `health-collector.js`,
`packet-witness.js`. It imports nothing of another component.

## Other folders

- `services/identity/` — the installation id, outside the seven components
  ([`component-architecture.md`](component-architecture.md)).
- `store/source-registry.js` — registered sources; `utils/` — logger, units,
  shared helpers.
- `scripts/` — `check-tests-start-no-torrent.mjs` and build helpers;
  `assets/calibration/` — encode calibration samples.
- `openspec/` — specifications and changes of this repository.
