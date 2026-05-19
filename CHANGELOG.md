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
