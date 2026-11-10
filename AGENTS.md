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

## Checks scripts, changesets and release path

`scripts/check.sh` runs the same checks as CI one by one: `tools` (Node and npm
are the versions of `.node-version` and `packageManager`), `pins` (every
dependency, dev dependency and override is an exact version), `install`
(`npm ci` with its install scripts, retried), `guard` (the no-torrent guard),
`test` (`npm test`), `image` (`docker build`) and `all`, which
`dependencies.yml` runs on every commit it prepares. `install`, `test` and
`image` run under `timeout` with a limit named at the top of the script, and
say so when they stop one: `node --test` gives its test processes no limit, so a
test that waits for an event that never comes holds the run for ever. The shared
flow is in the
organization's
[`CONTRIBUTING.md`](https://github.com/torrent-tv/workflows/blob/main/CONTRIBUTING.md).

- Every pull request adds a changeset in the standard `@changesets/cli` format
  (`npx changeset`, or a file `.changeset/<branch with / as ->.md`): front
  matter `"@torrent-tv/proxy": patch` (or `minor`; never `major`), then one
  sentence a viewer understands. CI (`changeset status --since=origin/main`)
  refuses a pull request without one. A commit never edits or renames a
  changeset an earlier commit added: the release replays each commit and would
  stop on it.
- `package.json` and `package-lock.json` hold the released version; nobody edits
  it. After a merge to `main` the `version` job amends each commit that added a
  changeset with its version and its `CHANGELOG.md` entry (`changeset version`)
  and force-pushes `main` with a lease as the release App; three changeset
  commits give three versions. The next run checks the commits (one `Checks` leg
  per changeset commit of a pull request, so each published version was tested),
  builds the image, and then, for each version, `publish` publishes
  `@torrent-tv/proxy@<version>` to npm from that version's commit
  (`changeset publish`, npm trusted publishing: npmjs.com accepts the OIDC token of
  `torrent-tv/proxy`, `main.yml`, environment `production`; no npm token exists),
  tags it (`changeset git-tag`) and creates the GitHub Release from the
  `CHANGELOG.md` section. Its last step starts `dependencies.yml` of
  `torrent-tv/ha-addon` with the newest version (`proxy-version`); that workflow
  waits until npm serves it and installs it into the add-on. `rebase-prs`
  rebases the open pull requests onto the rewritten `main`. Re-running a failed
  job is safe: each step finishes only what is missing.
- `dependencies.yml` raises Dependabot alerts and minor updates daily, with a
  changeset per commit, and pushes the commits that passed (`fix(deps)` when
  `dependencies` in `package.json` changes, else `chore(deps)`). WebTorrent and
  uint8-util are held back on purpose (see the comment in the workflow). An alert
  that does not apply is dismissed in Dependabot with a reason, not listed in a file.
  The rules, the states of a commit and the unknowns:
  [`openspec/changes/release-with-changesets/design.md`](openspec/changes/release-with-changesets/design.md).
