## 2.9.24

- **New**: IPv6-first support (roadmap step 5a). (1) A second STUN server (`stun.cloudflare.com:3478`, alongside Google's) is added to the ICE config — both have IPv6 (AAAA) records, so when the proxy host has a global IPv6 address it gathers a `srflx` candidate over v6 too. IPv6 has no NAT, so if both the proxy and a (v6-native, e.g. cellular) viewer have global v6, the connection can go **direct** over v6 — sidestepping the whole NAT-traversal machinery. (2) Candidate logging now classifies each candidate by address scope — `v4-private` / `v4-public` / `v6-global` / `v6-ula` / `v6-linklocal` / `v6-loopback` (replaces the old private/public host label) — so the field log shows whether a global IPv6 path is actually being offered and chosen. Audited the candidate path: the proxy already forwards ALL candidates (incl. global v6) and the browser adds them all — nothing was dropping global v6, so no filter fix was needed. NOTE: not verifiable on the dev's proxy (its ISP exposes only ULA v6 `fd…`, no global v6); needs a proxy with global v6 to confirm in the field — the new `v6-global` log tag is there to spot it.
- **Fix**: Cold-start playback no longer fails with "Data channel request timed out". `POST /api/playback-plan` (`playback-planner.getPlan`) used to block up to 60 s waiting for the file header to download for the codec probe — exactly the transport's 60 s request timeout, so a cold torrent (peers still connecting, 0 % header) raced and failed. The planner now takes a short per-request budget (`maxWaitMs`, 8 s from the route): it prioritises the file header and probes, and if the header still isn't down it returns the plan flagged `pending: true` (uncached) instead of blocking. The browser polls again — each call keeps the header prioritised — so no single request approaches the 60 s limit and the existing `/stats` poll keeps showing live peers/speed/% the whole time. Pairs with server 0.8.24 (browser-side poll loop, already live).
- **New**: Disk hygiene (Level 1, `torrent-pool.js`). (1) A torrent with **zero active file readers** is now removed together with its on-disk store after a 300 s idle TTL (`torrent.destroy({ destroyStore: true })`), so downloaded data no longer accumulates while the proxy keeps running; re-requesting the torrent re-adds it. Re-acquiring a file cancels the pending removal, and the TTL is generous so brief gaps between ffmpeg range reads (or a short pause) never evict an in-use torrent. (2) **Startup orphan sweep**: leftover torrent data under `os.tmpdir()/webtorrent` from a previous hard kill (where graceful `destroyAll` never ran) is cleared at construction (safe — no torrents loaded yet). Still pending (Level 1): a global disk cap with LRU eviction.

## 2.9.23

- **New**: Symmetric-NAT port prediction for WebRTC (roadmap step 4; `webrtc-manager.js` + `nat-classifier.js` delta + `cli.js` wiring). When the startup NAT classification reports a **symmetric** NAT, for each real IPv4 `srflx` candidate the proxy also offers predicted-port candidates at `base + delta*k` (k = 1..16, `delta` = the per-destination external-port step measured at startup), each with a unique ICE foundation. The browser probes these too; if one matches the external port the NAT assigns for the proxy→browser path, ICE connects — the practical, signalling-only form of the birthday-paradox trick (no node-datachannel changes, no extra sockets). **Scope**: covers sequential/predictable symmetric NATs; a fully-random symmetric NAT (where the true 256-socket birthday would be needed) is not solved by this and is out of reach on the node-datachannel stack. No-op for cone NATs (the fixed-port mapping already suffices) and IPv6 (no NAT). Diagnostics: logs the injected predicted ports per session (`symmetric NAT (delta=D) — injecting N predicted srflx candidates: …`); combined with the existing `selected pair local=[…]` log this shows whether a predicted port won. NOTE: could not be exercised end-to-end — the dev's home NAT is cone; needs a symmetric-NAT vantage to verify in the field (the logging is there to diagnose it when it appears).

## 2.9.22

- **Fix**: The proxy no longer crashes on a repeat/remote WebRTC session (regression from 2.9.18). Two causes, both fixed: (1) `webrtc-manager.handleSignal` called `setRemoteDescription`/`addRemoteCandidate` with **no try/catch**, so when node-datachannel threw synchronously (`Failed to gather local ICE candidates`) the whole process died — killing every viewer and the tunnel — and was restarted by s6. It now contains the error per session (logs + closes only that session, never throws out of the handler). (2) Root cause of the gather failure: 2.9.18 set `enableIceUdpMux` per-PeerConnection but with **no persistent mux owner**, so the shared UDP socket was bound/freed with each connection — a session opened while a just-closed one still held the fixed port could not bind it and failed to gather. Fixed by creating ONE persistent `IceUdpMuxListener` on the fixed UDP port once at startup (owned by the WebRTC manager for the proxy's whole lifetime, released on shutdown via `dispose()`); every session keeps `enableIceUdpMux` + the same port and demuxes over the shared socket by ICE ufrag. This keeps the clean single-port model (one UDP port, one UPnP mapping, one reachable endpoint) while surviving session churn. Verified against libdatachannel issue #861 and locally: 5 sequential + 2 concurrent PeerConnections all gather on the one port with no error, and the srflx candidate carries the fixed port.

## 2.9.21

- **Chore**: Diagnostic — the `/api/sources/:key/stats` route now logs the real swarm state on every poll: `[stats] <key> peers=N down=NKB/s file=N% header=down/totalB`. This surfaces a cold-start download stall (0 peers / header not advancing), which is what makes `POST /api/playback-plan` block on the codec probe until the browser's data-channel request times out. (Diagnosis: on the first/cold attempt the file header has not downloaded within ~60 s — likely worsened by `uTP not supported` on arm64/musl limiting peers — so the blocking probe times out; a warm attempt minutes later, with the header already cached, probes in ~25 ms and plays. Verified by the same torrent failing cold on cellular and playing warm on desktop.)

## 2.9.20

- **New**: Startup NAT classification (`services/nat-classifier.js`, dependency-free — `node:dgram` + `node:crypto`). From a single local UDP socket the proxy sends a STUN Binding Request to two different public STUN servers (Google + Cloudflare) and compares the reflexive external port: same → **endpoint-independent (cone)** NAT (the fixed-port WebRTC mapping from 2.9.18 is sufficient, no port prediction needed); different → **symmetric** NAT (the mapped port varies per viewer, so WebRTC will need port prediction — a later roadmap step). The class is logged at startup. Best-effort: STUN probes are time-bounded and never block startup; an inconclusive probe is logged and ignored. Uses the modern dual-server, single-socket test (no RFC 3489 CHANGE-REQUEST, which public STUN servers like Google's do not support). Evaluated `@xmcl/stun-client`/`stun` (both MIT) but their public APIs create a fresh socket per query and/or rely on CHANGE-REQUEST, which is wrong for this test — hence the minimal in-house client.

## 2.9.19

- **Chore**: Diagnostics for verifying remote WebRTC reachability and root-causing failures. `port-mapper.js` now logs a `removed mapping for <proto> <port>` line on clean shutdown unmap (previously silent on success). `webrtc-manager.js` now logs the **full** local ICE candidate (`addr:port typ …`, so the pinned UDP port is visible), every **ICE-state** transition (`checking → connected/failed`), and — on connect — the **selected candidate pair** (`local=[…] remote=[…]` with type/address/port), the single most useful line for "did the WebRTC path connect, and over which route (LAN / public srflx v4 / v6)".

## 2.9.18

- **New**: WebRTC is now reachable behind NAT via a static UDP port mapping. All sessions are pinned to a single UDP port (same number as the HTTP port, default 9090) and multiplexed over it (`enableIceUdpMux` + `portRangeBegin`/`portRangeEnd` in `webrtc-manager.js`), and that UDP port is UPnP/NAT-PMP-mapped at startup (a second `port-mapper.js` instance, protocol UDP, removed on shutdown). Because the socket is bound to a fixed, statically-mapped port, the proxy's `srflx` ICE candidate now carries `publicIP:9090` — reachable from the browser even behind symmetric NAT for that port (previously WebRTC used an ephemeral UDP port that UPnP could not map). Verified: two PeerConnections share the one UDP port with no bind conflict; host + srflx (v4 and global v6) candidates all carry the fixed port. The UDP endpoint is not reported to the server (the browser learns it via ICE, not the TCP dial-back probe).

## 2.9.17

- **New**: The proxy reports its UPnP-mapped external endpoint to the server over the tunnel (new `proxy-endpoint` message: `{ externalIp, externalPort, protocol }` from `port-mapper.getMappedEndpoint()`). Sent when the mapping completes and re-sent on every tunnel (re)connect, so the server can dial back and verify the proxy is reachable from the internet (server 0.8.22). No effect if port mapping is disabled or failed.

## 2.9.16

- **New**: Automatic port mapping (`services/port-mapper.js`). At startup the proxy asks the home router to open its local port (default TCP 9090) via UPnP IGD / NAT-PMP using `@silentbot1/nat-api` (the same library WebTorrent already uses for the torrent port — no new host dependency). The mapping uses a 2 h lease auto-renewed while running and is removed on graceful shutdown (wired into the `cli.js` shutdown path; lease expiry is the backstop on a hard kill). Strictly best-effort: a router without UPnP/NAT-PMP is a normal case — it is logged and the proxy continues. Bounded by start/stop timeouts so a non-responding gateway never delays startup or hangs shutdown. Disable with `--no-port-mapping`. The discovered external endpoint is exposed via `getMappedEndpoint()` for the upcoming server-side reachability probe (not yet reported). `@silentbot1/nat-api` is now a direct dependency (was transitive via WebTorrent).

## 2.9.15

- **Fix**: Torrent data is now cleaned up on graceful shutdown. `TorrentPool.destroyAll()` removes every torrent **with its on-disk store** (`torrent.destroy({ destroyStore: true })`) and then tears down the WebTorrent client; it is wired into the Fastify `onClose` hook (after `hlsSessionManager.disposeAll()`, so ffmpeg readers stop before their source files are removed). Previously nothing called `client.remove()`/`torrent.destroy()` anywhere, so downloaded files accumulated under `os.tmpdir()` until the process was killed — and even a clean SIGTERM/SIGINT left them behind. (First step of disk-hygiene Level 1; refcount/TTL removal and the startup orphan sweep are separate, still pending.)

## 2.9.14

- **New**: `GET /api/sources/:sourceKey/stats` now reports `headerBytes` / `headerDownloadedBytes` — how much of the file's header/index region (leading 256 KB + trailing 2 MB, the bytes the codec probe needs) is downloaded, counted by whole torrent pieces from the bitfield. Lets the browser show the download phase's progress and ETA toward the next (transcode) phase. Coarse by design (piece granularity).

## 2.9.13

- **Fix**: Video-copy path (`video=copy`, audio transcoded or copied) no longer drops video / desyncs audio at the start. The output timeline is now forced 0-based: the container `start_time` (parsed from the probe; many MKVs report ~0.1 s) is subtracted via `-output_ts_offset -start_time` together with `-copyts`, so segment 0 begins exactly at 0 with audio and video aligned (previously `-copyts` preserved the non-zero start, leaving a hole at the beginning where video was blank but audio played).
- **New**: Unified segment-boundary model. The synthetic VOD playlist and all seek math now come from a boundary table: a uniform grid for re-encoded video, and the source's **real keyframe positions** (probed once with ffprobe, normalized to 0) for copied video — so the declared segment boundaries match where a copied stream actually cuts, eliminating seek gaps. The keyframe probe is time-bounded (~6 s); on slow containers it falls back to the uniform grid (start still 0-based). Session log shows `seg=keyframe|uniform` and `start=…`.

## 2.9.12

- **Fix**: Eliminate PTS-gap glitches (stutter/freeze on video while audio keeps playing) at start and after seeking, for both transcode modes:
  - **Branch A — video re-encoded** (`video=libx264`): use a fixed GOP (`-g`/`-keyint_min` = segmentDuration × fps, `-sc_threshold 0`) instead of `-force_key_frames expr:gte(t,n_forced*SEG)`. The old expression broke after a seek because `t` is shifted by `-output_ts_offset`, forcing keyframes at the wrong places and producing segments that did not line up with the playlist grid. A frame-count GOP is offset-independent → every segment is exactly segmentDuration and starts on a keyframe.
  - **Branch B — video copied** (`video=copy`, only audio transcoded): keep the source's real timestamps with `-copyts` (and accurate seek) instead of relabelling onto a 4 s grid that does not match the source's own keyframe positions. Relabelling was the source of the holes in this mode.
- **Chore**: Session-start log tags the active branch (`branch=A(reencode,fixed-gop)` / `branch=B(copy,copyts)`) so glitches can be attributed to the right mode.
- **Fix**: Log timestamps reverted to UTC (`HH:MM:SS.mmm`) so the proxy and browser logs share one timezone and line up exactly when correlated.

## 2.9.11

- **New**: Seek-aware torrent piece prioritization. On every `/stream` range request the proxy now marks the torrent pieces at the read position **critical** (`TorrentPool.prioritizeByteRange` → `torrent.critical`, ~8 MB window). After a seek, ffmpeg opens the input at a new byte offset; previously those pieces waited behind the sequential download backlog, so seeking into an undownloaded region stalled ~15-18 s while the proxy fetched data. Now the seek position jumps the download queue.

## 2.9.10

- **Fix**: Raised the adaptive-preset speed margin (`PRESET_SPEED_MARGIN` 1.3 → 1.8). The preset benchmark runs at startup with an idle CPU, but during playback ffmpeg competes with in-process WebTorrent (download + SHA1 hashing) and delivery, so real throughput is lower than benchmarked. A 1.3× margin picked a preset that ran near/below realtime under load (e.g. `faster` at ~1.3×) and stalled; 1.8× picks a preset with genuine headroom (e.g. `veryfast`), keeping playback above 1× under real load.

## 2.9.9

- **Fix**: Software (libx264) video transcode is much faster on weak ARM hosts, so playback keeps up with realtime: encode uses all CPU cores (`-threads`), and the scaler **never upscales** — the target box is capped to the source size via `min(W,iw)`/`min(H,ih)`, so a small source (e.g. 720x400) is encoded at its own resolution instead of being scaled up to the viewport (far fewer pixels).
- **New**: Adaptive software preset (preset auto-benchmark). At startup the proxy benchmarks libx264 presets (`fast`→`ultrafast`) on this host and records encode throughput (pixels/sec). Per stream, `hls-session-manager` picks the **highest-quality preset that still encodes the actual (source-capped) output resolution faster than realtime** with a safety margin, falling back to `ultrafast`. This maximises quality without dropping below 1× (which causes stalls). Logged as `video=libx264/<preset>` at session start.
- **New**: The input probe (`probeInputMediaInfo`, formerly `probeInputDurationSeconds`) now also extracts the source video resolution from the container header (used by the adaptive preset to compute the output pixel rate). Still returns on the header without decoding the stream.
- **Fix**: Transcode no longer thrashes between positions. `#ensureEncodingFor` now anchors the look-ahead window on the **current** encode position (not the run's start), and a `RESTART_COOLDOWN_MS` guard ignores competing seek-restart requests for a few seconds. Previously a stalled player requesting distant segments (e.g. #2 and #107) made ffmpeg ping-pong, restarting endlessly and producing nothing — which `Error opening input file` races confirmed.

## 2.9.7

- **Fix**: `playback-planner` retries the codec probe while the file header is still downloading and no longer caches an **empty** probe result. Previously a transient empty probe (common for a later file in a multi-file torrent whose pieces arrive late) was cached permanently, so the file was mis-planned as directly playable forever — an unsupported video codec (e.g. xvid) got copied and played as a **black screen**. The probe now retries (up to 60 s) until at least one codec is detected, and only a successful detection is cached.

## 2.9.6

- **Fix**: `probeInputDurationSeconds` now returns as soon as ffmpeg prints the container header (`Duration:`) instead of letting `-f null -` decode the whole stream until the 8 s timeout. Transcode-session creation was wasting ~8.6 s per session on this redundant decode (the duration was already available from the header, and `playback-plan` had probed it moments earlier). Cuts session-creation latency from ~9.7 s to ~1 s.
- **New**: `GET /api/transcode-sessions/:id/progress` now includes `segmentDurationSec`, so the browser can show progress toward the first segment (the only thing it waits for before playback) instead of a percentage of the whole-file transcode.

## 2.9.5

- **Fix**: Segment files are now read with a 4 MB `highWaterMark` (`hls-session-manager.js` `getFileStream`) so the body is delivered in few, large chunks. On a busy ARM host the in-process WebTorrent hashing starves the Node event loop in bursts while the first segments are served; reading in fewer iterations cuts the time lost between chunks (the first segment previously transferred in ~79 × 43 KB reads spaced ~610 ms apart).

## 2.9.4

- **Chore**: Temporary `[net-debug]` instrumentation in `data-channel-handler.js` now splits transfer timing into `fetchMs` (waiting for the local route, incl. ffmpeg segment finalization), `ttfbMs` (time to first body chunk), `sendMs` (channel send duration) and `chunks`, to locate where early-segment latency is spent (transport vs segment production).

## 2.9.3

- **New**: WebRTC data-channel response bodies are now sent as **binary** frames (`sendMessageBinary`) instead of base64-encoded JSON `response-chunk` messages, removing the ~33% base64 overhead and the JSON encode cost. Frame layout: `[flags(1)][idLen(1)][requestId(ASCII)][payload]`. Control messages (`response-start`, `response-error`, `pong`) remain JSON strings. Requires the matching browser client (server ≥ 0.8.0); **deploy the server before the proxy**.
- **New**: Backpressure on the send loop — `data-channel-handler.js` pauses queuing body chunks once the channel's `bufferedAmount()` exceeds 8 MB and resumes when it drains below 1 MB (`setBufferedAmountLowThreshold` + `onBufferedAmountLow`), with a 5 s timeout fallback. Prevents the SCTP send buffer from ballooning and stalling throughput.

## 2.6.3

- **Fix**: Data channel handler now logs **all** requests regardless of body presence — `GET /transcode/…`, `GET /api/…/progress`, `GET /api/…/stats` etc. were previously invisible in logs. Non-2xx response statuses and fetch errors are also logged, enabling diagnosis of HLS manifest load failures.

## 2.6.1

- **Fix**: `TorrentPool.getTorrent()` — eliminated a race condition where two concurrent requests for the same torrent both found the cache empty and both called `client.add()`, causing WebTorrent to throw "Cannot add duplicate torrent". In-flight promises are now cached in a private `#pending` map; subsequent requests for the same key join the existing promise instead of triggering a second `client.add()`.

## 2.5.15

- **New**: `GET /api/sources/:sourceKey/stats?fileIndex=N` — returns live torrent stats: connected peer count, download/upload speed, per-file download progress and size. Used by the browser to show meaningful feedback while waiting for file metadata.
- **New**: `TorrentPool.getFileStats()` — reads `torrent.numPeers`, `torrent.downloadSpeed`, `file.progress`, `file.downloaded`, `file.length` from the WebTorrent instance.

## 2.5.14

- **New**: `TorrentPool.prefetchFileEdges()` — opens WebTorrent read streams for the first 256 KB and last 2 MB of a file before ffprobe runs. This prioritises the torrent pieces that contain file headers (FTYP box) and the MOOV atom (typically at end of non-faststart MP4), ensuring codec and duration detection succeeds even for freshly-added torrents. Timeout is 5 minutes; failure is non-blocking.
- **New**: Seek-to-position HLS transcode — `createOrGetSession` now accepts `startPositionSeconds`. ffmpeg is started with `-ss <pos>` (fast keyframe seek before `-i`) and `-output_ts_offset <pos>` so that output PTS matches the original timeline, keeping `video.currentTime` correct after a seek restart. Session cache key includes the rounded start position (10 s buckets) so nearby seeks share a session.
- **New**: `POST /api/transcode-sessions` accepts `startPositionSeconds` in the request body.
- **Chore**: `computeProgressMetrics` updated to compute percentage relative to the remaining duration from the seek point rather than the full file.

## 2.5.13

- **Fix**: HLS playlist type changed from `vod` to `event`. With `vod`, ffmpeg only wrote `#EXT-X-ENDLIST` after transcoding the entire file, blocking playback start for large files indefinitely.
- **Fix**: `waitForHlsPlaylist` in the browser now unblocks as soon as `#EXTINF:` appears (first segment ready) instead of waiting for `#EXT-X-ENDLIST`. Latency to first frame drops from minutes to seconds.
- **Fix**: Codec detection in `PlaybackPlanner` — when ffprobe returns an empty audio codec (MOOV atom not yet downloaded), the plan now defaults to `direct` mode instead of forcing HLS transcode. The browser's range-request mechanism fetches the MOOV atom on demand.

## 2.5.12

- **New**: Timestamps (`HH:MM:SS.mmm`) added to all log lines.
- **New**: Proxy version logged at startup (`Starting @torrent-tv/proxy vX.Y.Z`).
- **Fix**: WebRTC session torn down immediately after connect — `disconnected` ICE state is transient and no longer triggers `closeSession()`. Only `failed` and `closed` are terminal. This fixed data channels opening and closing within milliseconds.
- **Fix**: Fastify `bodyLimit` raised from 10 MB to 256 MB — large `.torrent` files encoded as base64 JSON exceeded the previous limit.

## 2.5.7

- **Fix**: WebRTC connection failure behind symmetric NAT — all ICE candidates (private and public) are now sent to the browser immediately. The browser attempts all paths in parallel; the local LAN path succeeds when browser and proxy are on the same network. Chrome's Private Network Access dialog appears once on first connect.

## 2.5.6

- **Fix**: ICE candidate filtering — private host candidates (RFC 1918, Docker bridge IPs, IPv6 ULA/loopback) are now buffered and suppressed when a public srflx candidate is available. This eliminates the Chrome/Brave Private Network Access permission dialog when connecting from a page served over HTTPS. Falls back to private candidates if no public srflx candidate is gathered (e.g. STUN unreachable), so connectivity is preserved at the cost of the PNA dialog.

## 2.5.5

- **Fix**: Tunnel keepalive — proxy now sends a WebSocket ping to the server every 30 s to prevent Cloudflare's ~100 s idle-connection timeout from dropping the tunnel.

## 2.5.3

- Internal: improved tunnel reconnect logic and error logging.

## 2.0.0

- **New**: WebRTC P2P tunnel architecture — replaced direct HTTP streaming with a persistent WebSocket tunnel to the server. Video is delivered from the proxy to the browser over a WebRTC data channel; the server acts only as a signalling relay.
- **New**: `node-datachannel` dependency for server-side WebRTC.
- **Removed**: `public_base_url` config — no longer needed.
