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

- `bin/cli.js` — CLI entry; resolves `ffmpegBin` (uses `--ffmpeg-bin` if given,
  else bundled ffmpeg-static, else PATH `ffmpeg`).
- `server.js` — Fastify setup; detects the video encoder at startup
  (`detectVideoEncoder`) and passes it to `HlsSessionManager`.
- `routes/<path>/<method>.js` — same convention as the server repo.
  - `routes/stream/get.js` — byte-range torrent file streaming (HTTP 206).
  - `routes/api/playback-plan/post.js` — codec/container/duration probe result.
  - `routes/transcode/session-file/get.js` — serves HLS playlist/segments;
    long-polls while a segment is being produced, returns retryable 503 (never
    202 — hls.js can't consume it).
- `services/`:
  - `playback-planner.js` — single ffmpeg probe returns audioCodec, videoCodec,
    container, durationSeconds. `mode` is advisory; the browser decides.
  - `hls-session-manager.js` — one ffmpeg per (source, file, settings). Serves a
    synthetic full-duration VOD playlist; produces segments on demand; restarts
    ffmpeg at the requested segment for server-side seeking. Short idle TTL.
    Uses the detected `videoEncoder` for video re-encode (copy otherwise).
  - `hwaccel.js` — detect best H.264 encoder (NVENC/QSV/VAAPI/V4L2M2M) with a
    STRICT startup test: encode `testsrc2` through the real HLS pipeline, then
    verify each segment decodes independently (catches non-IDR/corrupted hw
    output). Falls back to software libx264. Runtime fallback to software if a
    hw encode later fails. v4l2m2m is gated by this test (fails on HA Yellow).
  - `data-channel-handler.js` — forwards WebRTC data-channel requests to the
    local HTTP server (loopback), so the same routes serve both transports.

## Gotchas

- Do NOT use `-hls_playlist_type event` — it breaks duration/seek. VOD only.
- A transitive dep (`ip-set`, via webtorrent) ships a hostile
  `preinstall: npx only-allow pnpm` that breaks `npm install`. The addon works
  around it with `--ignore-scripts` + a targeted rebuild of `node-datachannel`;
  if you ever change install flow, keep that in mind.

## Planned: public reachability (remote access)

Decided direction — full plan in the parent `../CLAUDE.md`. Proxy-side pieces:

- **Auto port mapping** — IMPLEMENTED (`services/port-mapper.js`, changelog
  2.9.16). UPnP IGD / NAT-PMP via `@silentbot1/nat-api` (now a direct dep; the
  same lib WebTorrent uses for the torrent port). Maps TCP 9090 with a 2 h
  auto-renewed lease, removed on shutdown (lease expiry covers hard kills).
  Best-effort + start/stop timeouts; `--no-port-mapping` opts out;
  `getMappedEndpoint()` exposes the external endpoint. NOT yet done: mapping the
  **UDP** port WebRTC actually uses (it binds ephemeral UDP ports, so this TCP
  mapping does not yet help WebRTC — roadmap step 3 in the parent CLAUDE.md).
  Also pending (next iteration): a success log line in `port-mapper.js` `stop()`
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

HLS segments are handled (`hls-session-manager.js`: idle TTL, `disposeSession`,
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

## Changelog

Every behavioural change must be recorded in `CHANGELOG.md` — add an entry under
a new `## <version>` heading at the top, following the existing
`- **New**/**Fix**/**Chore**:` format.

**Do NOT edit `package.json` version.** `npm run patch`/`minor` runs `npm
version …` which bumps it. Write the CHANGELOG entry at the version that bump
will produce: **current `package.json` version + 1 patch** (or + 1 minor).
Accumulate bullets into that single pending entry until it's published. See the
parent `../CLAUDE.md`.

## Release

`npm run patch` (publishes to npm + pushes tags). The HA addon then needs its
own version bump to pull the new package. Publish proxy BEFORE bumping the addon.

**Any proxy change requires bumping the ha-addon version** (`ha-addon/torrent_tv_proxy/config.yaml`). The addon installs the proxy from npm at build time and the build is cached; without a version bump the plugin will NOT update and keeps running the old proxy. So after `npm run patch`, always bump the addon `config.yaml` version, push, and update the addon.
