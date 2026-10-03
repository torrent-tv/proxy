# proxy — @torrent-tv/proxy (WebTorrent + ffmpeg)

Downloads a torrent and streams the chosen file to the browser, transcoding to
HLS only when needed. See the parent `../CLAUDE.md` for the overall architecture
and release process.

## Deployment-agnostic — important

The HA addon is only ONE way to run this; bare npm and Docker are planned. Keep
all code free of Home-Assistant assumptions. Anything host-specific (GPU
devices, ffmpeg build, CLI flags) belongs in the `ha-addon` layer. Hardware
detection must probe at runtime and fall back gracefully; do not assume a
Linux-only host (e.g. POSIX-only signals must degrade elsewhere).

## Layout

Browser request and response fields, compatibility defaults, and status meanings
are recorded in `docs/browser-proxy-contract.md`.

- `bin/cli.js` — CLI entry; resolves `ffmpegBin` (uses `--ffmpeg-bin` if given,
  else bundled ffmpeg-static, else PATH `ffmpeg`).
- `server.js` — the composition root: creates Fastify, initializes process-wide
  resources, calls `services/server/wire-outputs.js` for the output and encode
  service graph, registers each route explicitly, and passes its dependencies.
  `wire-outputs.js` is a subordinate assembler for that graph; it does not
  create the HTTP server or register routes.
- `routes/<path>/<method>.js` — same convention as the server repo.
  - `routes/stream/get.js` — byte-range torrent file streaming (HTTP 206).
  - `routes/api/playback-plan/post.js` — codec/container/duration probe result.
  - `routes/transcode/session-file/get.js` — serves HLS playlist/segments;
    long-polls while a segment is being produced, returns retryable 503 (never
    202 — hls.js can't consume it).
- `services/`:
  - `torrent/demand/` — what anybody wants, in BYTES: `Window` (claimant, file, byte
    range, urgency), `Urgency` (BLOCKED / NEAR / AHEAD / TAIL / BEHIND),
    `DemandRegister` (live windows by claimant), `pieces.js` (the one place
    bytes become piece numbers). No WebTorrent, no piece store, no pieces.
  - `torrent/download/` — `SwarmSelection`, the ONLY thing that calls `select`,
    `deselect` or `critical`, and `registry.js`, which holds one per torrent and
    owns the cross-torrent rule that withholds the speculative levels while
    anything urgent is missing anywhere. See `docs/download-architecture.md`.
  - `encode/output/` — domain layer: `OutputSpec`, `VideoOutput`, `AudioOutput`,
    `CutGrid`. What a session PRODUCES — which tracks, in what form, cut how,
    packaged how — and therefore its identity: two outputs whose parameters
    agree ARE the same output, and the encoded result is reused by definition.
    Nothing about a VIEWER appears in it (not the consumer id, not where they
    started, not their viewport), and nothing about the request that does not
    change a byte of the result. `server/ViewerRequests.js` builds one and keys
    the output on it.
  - **`media/` — THE MEDIA LAYER, one directory, and it answers ONE question:
    what does a FILE say about itself.** Its containers, its tracks, where its
    keyframes are, how long it runs, and the plan for playing it. Every fact in
    it is born when a header is read, dies when the file is forgotten, and is
    addressed by the file — which is the test that put them together. It used to
    be four places at two levels (`container/`, `tracks/`, half of
    `orchestrators/`, and `playback-planner.js` loose in `services/`), so the
    layer could not be put under an import rule and the rule was written per
    directory instead.
    Inside it, the DOMAIN is `media/container/` and `media/tracks/`: they import
    nothing but each other, this proxy's own logger included. The application
    files sit flat beside them — `ContainerOrchestrator`, `KeyframeTables`,
    `SubtitleOrchestrator`, `playback-planner.js`, `keyframe-probe.js`,
    `ffmpeg-banner.js`, `audio-inventory.js` — and may reach their own domain and
    the logger and nothing else. What a torrent CONTAINS, which clusters may be
    read, where a viewer stands, what an encoder costs: all handed in. Both
    reaches that existed are gone — `torrent-worker/subtitle-cues.js` is given to
    `SubtitleOrchestrator` by `server.js`, and `torrent/Contents.js` to the
    planner — so this layer can be exercised with plain values, no torrent, no
    thread and no disk. Checked by breaking it in every direction.
  - **The parse happens on the MAIN thread, and the torrent thread serves
    bytes.** It used to parse containers too — tracks, media info, keyframe
    index — and carry each answer back over the channel, on the stated ground
    that "the main thread cannot open a read stream on one of its files". True
    of WebTorrent's API, not of the bytes: a container is built from one
    function, `readRange(start, end)`, the pieces live in shared memory, and
    `WorkerTorrentPool.readRangeOf` is the read that serves every segment — it
    waits for what has not arrived and steers the swarm toward it. That split
    is what made "where is this fact kept" a question at all; with one thread it
    does not arise. NOTHING in that thread reaches into the media layer now —
    the subtitle cue walk was the last, and it is handed which byte ranges of a
    file are downloaded WHOLE (one list per pass, not a question per cluster)
    plus a store read that never fetches, both in
    `torrent/worker/held-bytes.js`. A piece arriving is ANNOUNCED
    (`PIECES_ARRIVED`) rather than acted on there. Pinned by
    `test/the-torrent-thread-serves-bytes.test.js`.
  - `media/container/` — domain: `Container` (abstract, RFC 9559 / ISO 14496-12),
    `MatroskaContainer` / `Mp4Container` / `AviContainer`, `ContainerFactory`
    (sniff 16 bytes → precise subclass), `KeyframeTable`. See
    `docs/container-architecture.md`.
  - `media/tracks/` — domain: `ContainerTrack` (base: TrackNumber, declaredIndex,
    language/BCP47, isEnabled/isDefault) → `VideoTrack` / `AudioTrack` /
    `SubtitleTrack` → `TextSubtitleTrack` / `ImageSubtitleTrack`,
    `ExternalSubtitleFile`. Spec-accurate flags (FlagForced only on subtitles per
    RFC 9559 §5.1.4.1, FlagOriginal/Commentary only on audio, tkhd
    track_enabled / alternate_group, elng BCP47).
  - `media/` application files: `ContainerOrchestrator` (detect + the ONE
    container per file, `containerFor`/`getTracks`/`getMediaInfo`/`getKeyframeIndex`;
    the container keeps its own reading of each element it states — the Segment
    layout, Tracks, Cues, MP4's `moov` — once it has been read), `KeyframeTables`,
    `SubtitleOrchestrator` (the track list and the cues behind
    `Container` tracks, warm/push — it is handed the walk, and `server.js` is
    what puts the two together), `SubtitleCues` (the plan, the found-order
    cursor, one walk of a file at a time, taking back withdrawn cues). It uses
    the file's one container — it no longer builds its own. The walk itself is
    `MatroskaContainer.readHeldCues` over `container/matroska-clusters.js` (which
    also finds clusters the Cues table does not name) and
    `Mp4Container.readHeldSamples`; what the torrent supplies is `held-bytes.js`
    — which ranges are downloaded whole, and a read of one that never fetches
    and answers at once with nothing where the range is not whole.
  - **A read whose bytes have not arrived is not an answer about the file.**
    Every container read is strict (`container/unavailable.js`): every byte, or
    `BytesUnavailable`. A value, a proven absence, or a refusal of ours with its
    reason may be kept; "not here yet" never is — not by a container, not by
    `ContainerOrchestrator`, not by `KeyframeTables`, not by `SubtitleCues`.
    **`KeyframeTables` is where a file's keyframe table lives and the only thing
    that reads one.** The table is `container/KeyframeTable.js`, ONE object per
    file, handed out rather than copied — so a read that lands after a session
    was made still reaches it, which a value could not. It answers two questions
    that a bag of probe fields could not tell apart: `answered` (a reader came
    back) and `readable` (it came back with times). The first distinguishes a
    file that must be re-encoded for ever from a passing shortage of bytes off
    the swarm. One read per file whoever asks, the second asker joins the first,
    each caller's wait is bounded by the measured `KEYFRAME_TABLE_BUDGET_MS`
    while the READ is not, and a read that threw — `BytesUnavailable` included —
    is never recorded as an answer; it is read again when pieces of the file
    arrive (`readAgainIfUnanswered`). It is the ONLY store of the keyframe
    answer; the container keeps the Cues reading the times are taken from. The second reader is the packet probe in
    `media/keyframe-probe.js`, which decodes rather than parsing; the fuller of the
    two answers is the one that stands (`media/keyframe-probe.js`).
  - `server/controllers/` — interface layer: `PlaybackController` / `SubtitleController`
    (thin adapters over orchestrators; routes depend on controllers, not services).
    `routes/*` are now thin HTTP translators. A controller reaches every layer
    below it THROUGH its orchestrator and never around it, which biome checks —
    so what an orchestrator needs from another layer is composed in `server.js`
    and passed in.
  - Everything a container states about ITSELF lives in its own class: the
    track table, the Cues, the keyframe times they name, the cluster positions,
    the blocks inside a cluster, the MP4 sample table, and the walk of what is
    downloaded. `services/container-index/` is gone; `container/ebml-reader.js`
    is the format's byte-level grammar, not its statements, and is the only
    piece kept apart. `ContainerFactory` is the ONE place that decides what a
    file is — by sniffing the header, since that is what the muxer wrote — and
    that is it. `ContainerFactory.readKeyframeIndex` is gone: it existed only for
    the session manager's own HTTP read of a container, which is deleted.
  - `docs/download-architecture.md` — the two axes of downloading: what is
    wanted (`demand/`) against what the swarm is told (`download/`), why urgency
    is not a number given to the library, and why the speculative levels are
    withdrawn rather than lowered.
  - **The storage layer — ONE layer, FOUR directories.** Bytes on a medium with
    a limit is the property they share; what holds them are three different
    things with different lifetimes, different addresses and different THREADS,
    so they are not flattened into one:
      - `storage/piece-store/` — the torrent's pieces: memory tier, spill tier, and the
        order they leave in (`shared-piece-store.js`, `piece-lru.js`,
        `piece-disk-store.js`). Lives in the torrent WORKER thread.
      - `storage/segment-store/` — the segments an encoder has produced
        (`SegmentStore.js`), addressed by the output's own key. Main thread.
        It keeps bytes and what is read from them; whether a piece is whole is
        decided by the encoding (`encode/piece-completeness.js`).
      - `storage/files/` — files downloaded whole and kept as files
        (`CompletedFiles.js`, `piece-from-whole-file.js`). Worker thread.
      - `storage/` — THE ONE BUDGET: how much of this machine the proxy may
        take, and how that is divided between everything that holds bytes.
        `MachineBudget.js` is the single owner; `allowance.js` the rule;
        `machine-memory.js` and `free.js` read the machine; `wire.js` says who
        the claimants are and which RESOURCE each takes; `keep.js` and
        `returns.js` say how long material nobody is using is kept. It holds no
        bytes itself.
        **One budget does not mean one number.** Memory cannot be paid for with
        disk, so what is divided is divided per resource — and "disk" is one
        resource per DEVICE, read with `statSync(dir).dev`, because two
        filesystems cannot pay for each other either (`/tmp` and `/data` on the
        addon host are two). What there is ONE of is the owner, the policy and
        the place that reads the machine. One owner because the claimants TRADE
        across resources: pieces that do not fit in memory are spilled to disk,
        so what memory is given decides how much disk is needed — 14 400 MB
        spilled in fifty minutes while the store held 312-424 MB.
        The policy is the operator's, stated once at startup — `--budget
        adaptive|share|fixed`, `--budget-share`, `--budget-bytes`,
        `--min-memory-bytes`, `--min-disk-bytes` — and those are the only
        chosen numbers in the proxy, because they are chosen by the person whose
        machine it is. The default is the measured one.
    They may import each other and nothing above, which `biome` checks as an
    EXCEPTION to `../**` rather than as a list of forbidden layers — a layer is
    not a directory, the blanket form cannot say "my siblings", and a list of
    names misses whatever it forgets.
  - `docs/storage-architecture.md` — the three things that write to one disk, the
    two rules that remove material (nobody needs it, or there is no room), the
    order the viewers give that removal, why a spilled piece is a file of its
    own, and what is still not solved.
  - `docs/encode-architecture.md` — who decides where encoders go, and the
    answer is one authority: `EncodePlan`, from what is made, what is being
    made, what is wanted and what the host can hold. Why no viewer reaches it,
    why the priority map is read at two scopes (per FILE for the swarm, per
    OUTPUT for the encoders), and what each of the eight other places that used
    to place or kill an encoder now states instead.
  - `docs/logs.md` — where to find logs, and the fact that the BROWSER's own log
    is in TWO places split by phase: on the droplet while a transport is being
    acquired and at unload, on THIS proxy for the whole of a viewing
    (`/data/client-<start>-<session>-<torrent>.log`, one file per session).
    Read both before concluding anything from a half-session.
  - `media/playback-planner.js` — single ffmpeg probe returns audioCodec,
    videoCodec, container, durationSeconds. `mode` is advisory; the browser
    decides. `media/keyframe-probe.js` beside it is the OTHER reading of the same
    file, by decoding rather than by parsing, for containers that state no index.
  - `server/` — what a request does, one operation at a time, and nothing
    that lives longer than the operation: `ViewerRequests` (open an output of a
    file and be placed on it, state a position, report progress),
    `SegmentServing` (answer a playlist, init or segment request from the store,
    or hold it until the piece is whole), `OutputLifecycle` (dispose an output
    nobody is on, all of them at shutdown, adopt what an earlier process left),
    and `wire-outputs.js`, which builds the components and hands each the narrow
    host it reads. `hls-session-manager.js` is gone (2.87.0): each of its members
    is a method of the component that owns it. The operations own no long-lived
    fact: the init served for an output is kept by `SegmentStore`, the bytes read
    for an output by `EncodeRuns`, the cold-start measurement by `HostTimings`.
    They import no component's implementation — only the name of an output and
    of its playlist (`encode/output/index.js`) and the keeping period
    (`storage/keep.js`); biome checks it. A held request waits for the store's
    publication event, as long as the requester states (`X-Hold-Ms`) and no
    longer than it stays.
  - `encode/` beside the orchestrator: `OutputOpening` (which output answers a
    request for a file, made if it is not here yet — without knowing who asked),
    `EncodeRuns` (build a run where the plan places it, follow it, account for
    its end, and what its input has received), `EncoderSelection` (the encoder
    in use and the move to software), `Renditions` (the steps of a picture and
    its soundtracks, the master playlist, and which rung a viewer's page says it
    plays), `OutputTimes` (where each segment begins and how the cut table is
    corrected), `CushionReport` (how much film is ready in front of the
    viewers), `output-key-format.js` (which container a key names).
  - `viewer/`: every viewer has a name (`Viewers.of` refuses an empty one); the
    relation to outputs is stored only in `Viewer.outputs` and read the other way
    by `Viewers.forOutput`. A quality request belongs to one viewer and exists
    only in AUTO (`Viewer.askQuality`). The playback start forecast
    (`playback-readiness.js`) is the viewer's, because it predicts how the
    viewer's browser will play; `ViewerRequests` is handed it by
    `wire-outputs.js`. `media-time.js` is exact media time and the rule by which
    every Media Source engine joins buffered ranges — see
    `docs/playback-start-forecast.md`.
  - `torrent/` reaches the piece store by what it does (`piece-store-of.js`) and
    is handed the store's class by `torrent/worker/worker.js`, where that thread
    is assembled. `transport/` imports nothing of another component; `bin/cli.js`
    hands it the memory reading and the rule for which captures are kept.
  - `encode/hwaccel.js` — detect best H.264 encoder (NVENC/QSV/VAAPI/V4L2M2M) with a
    STRICT startup test: encode `testsrc2` through the real HLS pipeline, then
    verify each segment decodes independently (catches non-IDR/corrupted hw
    output). Falls back to software libx264. Runtime fallback to software if a
    hw encode later fails. v4l2m2m is gated by this test (fails on HA Yellow).
  - `transport/data-channel-handler.js` — forwards WebRTC data-channel requests to the
    local HTTP server (loopback), so the same routes serve both transports.

## Gotchas

- Do NOT use `-hls_playlist_type event` — it breaks duration/seek. VOD only.
- A transitive dep (`ip-set`, via webtorrent) ships a hostile
  `preinstall: npx only-allow pnpm` that breaks `npm install`. The addon works
  around it with `--ignore-scripts` + a targeted rebuild of `node-datachannel`;
  if you ever change install flow, keep that in mind.

## Planned: public reachability (remote access)

Decided direction — full plan in the parent `../CLAUDE.md`. Proxy-side pieces:

- **Auto port mapping** — IMPLEMENTED (`services/transport/port-mapper.js`, changelog
  2.9.16). UPnP IGD / NAT-PMP via `@silentbot1/nat-api` (now a direct dep; the
  same lib WebTorrent uses for the torrent port). Maps TCP 9090 with a 2 h
  auto-renewed lease, removed on shutdown (lease expiry covers hard kills).
  Best-effort + start/stop timeouts; `--no-port-mapping` opts out;
  `getMappedEndpoint()` exposes the external endpoint. NOT yet done: mapping the
  **UDP** port WebRTC actually uses (it binds ephemeral UDP ports, so this TCP
  mapping does not yet help WebRTC — roadmap step 3 in the parent CLAUDE.md).
  Also pending (next iteration): a success log line in `transport/port-mapper.js` `stop()`
  (`removed mapping for TCP <port>`) — today stop() only logs on failure, so a
  clean unmap on shutdown is silent.
- **Report endpoint to server** — ✅ DONE (proxy 2.9.17). The mapped endpoint
  is sent over the tunnel (`tunnel-client.sendEndpoint` → `proxy-endpoint`) on
  mapping success and on every tunnel (re)connect; the server dial-back-verifies
  reachability (server 0.8.22, roadmap step 2).
- **HTTPS listener**: serve the existing routes over TLS with a per-proxy
  certificate delivered by the server through the tunnel (persist cert+key
  locally; ~90-day renewals are pushed the same way). Add CORS headers for the
  web-app origin so hls.js / `<video>` can fetch cross-origin.
- Plain HTTPS becomes the preferred video transport; WebRTC data channel stays
  as fallback for hosts where no port could be opened.
- **Later roadmap steps** (single staged roadmap in parent `../CLAUDE.md`,
  WebRTC-first ordering): step 3 map the WebRTC UDP port (fixed
  `portRangeBegin`/`End` + UPnP-map UDP); step 4 birthday-paradox port
  prediction (open ~256 UDP sockets, inject predicted-port ICE candidates) for
  symmetric NAT; step 5 IPv6-first (audit the candidate filter — do not drop
  *global* v6) + STUN NAT pre-classification reported to the registry; then
  the DNS+TLS path (steps 6–7); step 8 relay-then-upgrade (deferred).
- Future: ed25519 proxy identity (sign announcements), BEP 44 endpoint
  announcements via the `bittorrent-dht` already bundled with WebTorrent.

All of this must stay deployment-agnostic (HA addon, bare npm, Docker).

## Disk hygiene (open item — torrent data is NOT cleaned up today)

HLS segments are handled (`server/OutputLifecycle.js`: idle TTL, `disposeSession`,
`disposeAll`). Torrent data is **partially** handled: shutdown cleanup is done
(`TorrentPool.destroyAll()` with `destroyStore: true`, wired into the `onClose`
hook — proxy 2.9.15), but `deselect()` only stops further download and nothing
removes a torrent's data **while the proxy keeps running**, nor sweeps orphans
left by a previous hard kill at startup.

Level 1 — remaining: `client.remove(torrent, { destroyStore: true })` on last-
file refcount 0 + idle TTL (mirror the HLS session model); startup sweep of
orphaned store dirs under `os.tmpdir()`; global disk cap with LRU eviction of
whole torrents. (Shutdown teardown ✅ done.)
Level 2 (research): sliding-window chunk store. Full rationale in the parent
`../CLAUDE.md` "Disk hygiene" section.

## Cloud proxy

The same proxy code also runs as the company-hosted fallback when the user
pool can't serve a viewer. Keep the proxy host-agnostic so it runs unchanged on
rented infra (flat-rate/unmetered bandwidth — Hetzner dedicated / OVH; NOT
metered-egress clouds). Provider/economics analysis in the parent
`../CLAUDE.md` "Cloud proxy" section.

## Commits

Every commit header follows Conventional Commits (`<type>(<scope>)!: <subject>`,
types `feat fix perf refactor docs test build ci chore style revert`); CI refuses
a pushed commit that does not. Enable the local check once per clone:
`git config core.hooksPath .githooks`. Rules: `torrent-tv/.github` CONTRIBUTING.md.

## Changelog

Every behavioural change must be recorded in `CHANGELOG.md` — add a bullet
under `## Unreleased` at the top (create the heading if it is missing),
following the existing `- **New**/**Fix**/**Chore**:` format. Never write a
version heading and never edit the `package.json` version: the release job
does both. CI refuses a releasable push without an `## Unreleased` entry.

## Release

GitHub Actions releases; nothing is published from a workstation. A push to
`main` runs `.github/workflows/main.yml`: lint, the tests, and
`scripts/check-tests-start-no-torrent.mjs` (no check may start a real
torrent). Then, when the commits since the last `v*` tag ask for it (`feat`
→ minor; `fix`/`perf`/`revert` → patch; anything else → none), the release
job in the `production` environment:

1. writes the version into `package.json`/`package-lock.json` and renames
   `## Unreleased` to it, commits `chore(release): <version>` and tags it;
2. publishes `@torrent-tv/proxy` to npm with provenance;
3. pushes the tag and the commit and creates the GitHub release;
4. pushes `fix(proxy)`/`feat(proxy): install proxy <version>` to
   `torrent-tv/ha-addon` (`PROXY_VERSION` and the add-on changelog), whose own
   workflow builds the add-on image and releases the add-on.

So the order proxy → add-on is kept by construction. A release can also be
started by hand from the Actions tab with an explicit `patch` or `minor` step.
Updating the add-on on the Home Assistant host is still done there.

`.github/workflows/dependencies.yml` updates dependencies daily within the
ranges, runs the same checks and pushes to `main`.
