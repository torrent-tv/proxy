Read `../AGENTS.md` first. It holds the project-wide rules (a link to `meta/AGENTS.md` made by meta's setup script; a task worktree sees the same link). This file adds only what is specific to this repository.

# proxy — `@torrent-tv/proxy`

The proxy downloads a torrent with WebTorrent (in its own worker thread), reads
what each file states about itself, and serves the chosen file to the browser:
the bytes as they are, or HLS made by ffmpeg when the browser cannot play a
track. It keeps a WebSocket tunnel to the server for signalling and its state;
browser requests arrive over a WebRTC data channel and are forwarded to the
proxy's own Fastify routes over loopback. It is published to npm and installed
by `torrent-tv/ha-addon`.

## Deployment-agnostic

The Home Assistant add-on is one way to run the proxy; it also runs from npm and
from this repository's `Dockerfile`. Keep the code free of Home Assistant
assumptions: anything host-specific (GPU devices, the ffmpeg build, CLI flags of
one host) belongs in `ha-addon`. Hardware detection probes at runtime and falls
back; do not assume Linux (a POSIX-only signal must degrade elsewhere).

## Layout

- `bin/cli.js` — CLI entry and every option (`--help` lists them).
- `server.js` — the composition root (see the rules below).
- `routes/<path>/<method>.js` — one folder per URL path, one file per method;
  thin HTTP translators over `services/server/controllers/`.
- `services/<component>/` — `media`, `torrent`, `encode`, `viewer`, `storage`,
  `server`, `transport`, and `identity`. The components and how they talk:
  [`docs/component-architecture.md`](docs/component-architecture.md); each
  module and its owner: [`docs/layout.md`](docs/layout.md). The import rules
  themselves are the `overrides` in `biome.json`.
- `test/no-torrent/`, `test/with-torrent/` — see "Checks".
- `docs/` — architecture by subject:
  `browser-proxy-contract.md` (request and response fields the page relies
  on), `container-architecture.md`, `download-architecture.md`,
  `encode-architecture.md`, `encode-run-state.md`, `storage-architecture.md`,
  `playback-start-forecast.md`, `first-frame-wait-model.md`,
  `forecast-source-continuity.md`, `original-input-storage.md`, `logs.md`
  (where every log is), `socks5-egress-research.md` (not implemented).
- Planned work that is not in this repository yet: remote access (public
  reachability, per-proxy DNS and TLS, relay) in
  [meta `research/remote-access-direction-2026-07-11.md`](https://github.com/torrent-tv/meta/blob/main/research/remote-access-direction-2026-07-11.md),
  company-hosted cloud proxies in
  [meta `research/cloud-proxy-hosting-2026-07-10.md`](https://github.com/torrent-tv/meta/blob/main/research/cloud-proxy-hosting-2026-07-10.md).

## Rules every change must keep

- **`server.js` composes and does nothing else.** It holds no collection, no
  closure over 40 lines and no algorithm; `services/server/wire-outputs.js`
  assembles the output and encode graph under the same rule. What each of them
  does, step by step: [`docs/layout.md`](docs/layout.md), "Entry and
  composition". `test/no-torrent/composition-root-states-no-facts.test.js`
  refuses violations in both files.
- **Layers import only what their `biome.json` rule allows.** What a module
  needs from another layer is a constructor port, composed in `server.js` or
  `wire-outputs.js`. A controller reaches every layer below it through its
  orchestrator.
- **One owner per fact.** One container per file (`ContainerOrchestrator`), one
  keyframe table per file (`KeyframeTables`), one budget for the machine
  (`MachineBudget`), one place that tells the swarm what to fetch
  (`services/torrent/download/SwarmSelection`). Only the viewers' priority map
  states download demand (`docs/download-architecture.md`).
- **A read whose bytes have not arrived is not an answer about the file.** Every
  container read returns every requested byte or throws `BytesUnavailable`
  (`services/media/container/unavailable.js`); "not here yet" is never kept as
  a value, an empty track list or an unsupported format
  (`docs/container-architecture.md`).
- **The media layer is exercised with plain values.** `services/media/container/`
  and `services/media/tracks/` import only each other; the files beside them
  reach their own domain and the logger. Torrent contents, held bytes, viewer
  position and encoder cost are handed in.
- **Which thread does a piece of work is decided by measurement.** Today
  containers are parsed on the main thread from bytes in shared memory and the
  torrent thread serves bytes (`test/no-torrent/the-torrent-thread-serves-bytes.test.js`).
  A move needs a measured gain for the viewer and keeps one owner per fact.
- **The only chosen numbers are the operator's.** `--budget adaptive|share|fixed`,
  `--budget-share`, `--budget-bytes`, `--min-memory-bytes`, `--min-disk-bytes`;
  the default is measured (`docs/storage-architecture.md`). A new holder of
  bytes registers in `services/storage/wire.js`.
- **HLS is VOD.** The playlist lists every segment and `#EXT-X-ENDLIST`
  (`services/encode/output/playlists.js`); never use `-hls_playlist_type event`,
  which loses duration and seeking. A segment that is not ready yet is held or
  answered with a retryable 503, never 202 (hls.js cannot consume it).
- **fMP4 fragments are stamped with their own position on serve.** ffmpeg writes
  `tfdt` = 0 in every run that starts after a seek and puts the offset in that
  run's own init segment, while the player fetches one init per session; no
  ffmpeg option avoids it. `services/encode/segment-formats/` rewrites `tfdt`;
  do not remove that. Everything that depends on the segment format
  (`--segment-format fmp4|mpegts`) lives behind that interface.
- **Hardware encoders pass a strict test before use.** `services/encode/hwaccel.js`
  encodes `testsrc2` through the real HLS pipeline and checks that every segment
  decodes on its own; otherwise libx264, and a hardware failure at runtime moves
  to software. `h264_v4l2m2m` fails that test on HA Yellow.

## Checks: with a torrent and without

No check starts a real torrent outside the Home Assistant host, and the checks
are split by that property:

1. `test/no-torrent/` — every check that does not need a real torrent. `npm test`
   runs `biome lint .` and then only `test/no-torrent/**/*.test.js`, in CI and on
   a development machine. Two guards keep them from a torrent:
   `scripts/check-tests-start-no-torrent.mjs` (run by CI before the tests)
   refuses a line that constructs `TorrentPool`, WebTorrent or the torrent
   worker, imports WebTorrent, or names the proxy entry point; and
   `test/no-torrent/support/refuse-torrent.cjs`, loaded with `--require`, makes
   WebTorrent throw on construction and refuses DHT, tracker and
   local-discovery packages in every test process and worker thread.
   `test/no-torrent/refuse-torrent.test.js` fails if the guard is not loaded.
2. `test/with-torrent/` — checks that need a real torrent. Nothing loads them in
   CI or locally; they run only on the Home Assistant host. The folder holds no
   check yet; see its `README.md`.

## Gotchas

- Both images that install the proxy, this repository's `Dockerfile` and the
  add-on's, install with lifecycle scripts off (`--ignore-scripts`) and then run
  `scripts/install-native.sh`, which builds and checks the two native modules.
  Why scripts stay off (`ip-set`):
  [`ha-addon` AGENTS.md, Gotchas](https://github.com/torrent-tv/ha-addon/blob/main/AGENTS.md#gotchas).
- `utp-native` is our fork, `@torrent-tv/utp-native`, chosen by `overrides` in
  `package.json`. `scripts/install-native.sh` reads that override and fails
  when any other build survives.

## Changesets and release path

The shared flow, the changeset bullets and the frozen `CHANGELOG.md` are in the
organization's
[`CONTRIBUTING.md`](https://github.com/torrent-tv/.github/blob/main/CONTRIBUTING.md).
What is particular to this repository:

- A changeset's file name is lower case; its continuation lines are indented
  by two spaces; it has no blank lines; nothing else lives in `.changeset/`. A
  changeset is never edited or deleted after merge.
- `.github/workflows/main.yml` runs the shared checks (commit headers, branch
  name, line endings, workflows, changesets), the no-torrent check, `npm test`,
  and a `docker build` (the image runs `--help` in its last stage). Then it
  publishes to npm and installs the version into `ha-addon`.
