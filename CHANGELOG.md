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
