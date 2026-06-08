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

## Changelog

Every behavioural change must be recorded in `CHANGELOG.md` — add an entry under
a new `## <version>` heading at the top (the next patch version that
`npm run patch` will publish), following the existing
`- **New**/**Fix**/**Chore**:` format. See the parent `../CLAUDE.md`.

## Release

`npm run patch` (publishes to npm + pushes tags). The HA addon then needs its
own version bump to pull the new package. Publish proxy BEFORE bumping the addon.

**Any proxy change requires bumping the ha-addon version** (`ha-addon/torrent_tv_proxy/config.yaml`). The addon installs the proxy from npm at build time and the build is cached; without a version bump the plugin will NOT update and keeps running the old proxy. So after `npm run patch`, always bump the addon `config.yaml` version, push, and update the addon.
