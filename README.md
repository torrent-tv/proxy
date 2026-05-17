# @torrent-tv/proxy

A lightweight Node.js service that streams torrent content to browsers via a direct WebRTC P2P data channel or, when needed, HTTP. It handles torrent fetching, codec detection, and on-demand HLS transcoding with ffmpeg.

## Why this exists

- Browsers cannot consume torrents directly.
- This service exposes torrent files through HTTP (`/stream`) with Range support, and through a WebRTC data channel for NAT-traversed streaming.
- It can transcode audio (or video + audio) to HLS on demand so the browser can always play the content regardless of codec support.
- It registers itself in an external registry server and maintains a persistent tunnel WebSocket so the server can route browser requests and WebRTC signals to it.

## Architecture Overview

```mermaid
graph TB
  subgraph Browser
    WP[WebRtcProxy]
    HLS[HLS.js + WebRtcHlsLoader]
  end

  subgraph Server["Registry Server"]
    API[REST API]
    TS[ProxyTunnelServer]
    SH[SignalHub /ws/browser-signal]
  end

  subgraph Proxy["@torrent-tv/proxy (Fastify)"]
    TC[TunnelClient]
    WM[WebRtcManager]
    HC[HealthCollector]
    DCH[DataChannelHandler]
    PP[PlaybackPlanner]
    HLM[HlsSessionManager]
    TP[TorrentPool]
    FF[ffmpeg]
  end

  TC -->|"persistent WebSocket /ws/proxy-tunnel"| TS
  TC -->|re-register on reconnect| API
  HC -->|metrics: cpu, mem, load| TC

  TS <-->|signal forward| SH
  SH <-->|WebSocket| WP

  WP <-->|"P2P data channel (STUN)"| WM
  WM --> DCH
  DCH --> TP
  DCH --> HLM
  HLM --> FF

  HLS -->|segment/manifest fetches| WP
```

## Service Internals

### TunnelClient

Opens one persistent WebSocket to the registry server's `/ws/proxy-tunnel` endpoint on startup.
Reconnects automatically with back-off on unexpected close.

Handles three inbound message types from the server:

| Message type | What the proxy does |
|---|---|
| `health-request` | Calls `HealthCollector`, sends `health-response` back through tunnel |
| `signal` | Forwards SDP offer or ICE candidate to `WebRtcManager` |
| `relay-request` | Fetches the path from local Fastify, streams `relay-response` back |

### WebRtcManager

Manages RTCPeerConnection sessions keyed by `sessionId`. On receiving an SDP offer from the server it creates a peer connection using [`node-datachannel`](https://github.com/murat-dogan/node-datachannel), generates an answer, and exchanges ICE candidates through the tunnel. When the data channel opens it hands it off to `DataChannelHandler`.

```mermaid
sequenceDiagram
  participant S as Server (via TunnelClient)
  participant WM as WebRtcManager
  participant DC as DataChannelHandler

  S->>WM: { type:"offer", sessionId, sdp }
  WM->>WM: createPeerConnection(sessionId)
  WM->>WM: setRemoteDescription(offer)
  WM->>WM: createAnswer()
  WM->>S: { type:"answer", sdp }

  loop ICE candidates
    WM->>S: { type:"candidate", candidate, mid }
    S->>WM: { type:"candidate", … }
  end

  Note over WM: data channel opens
  WM->>DC: handleChannel(dataChannel)
```

### DataChannelHandler

Receives JSON `request` messages over the data channel and dispatches them to the proxy's local Fastify server. Responses are streamed back as base64 `response-chunk` messages.

**Wire protocol (browser ↔ proxy):**

| Direction | Type | Key fields |
|---|---|---|
| Browser → Proxy | `request` | `requestId`, `method`, `path`, `query`, `headers`, `body` |
| Proxy → Browser | `response-start` | `requestId`, `status`, `headers` |
| Proxy → Browser | `response-chunk` | `requestId`, `data` (base64), `done: true\|false` |
| Proxy → Browser | `response-error` | `requestId`, `error` |
| Browser → Proxy | `ping` | `id` |
| Proxy → Browser | `pong` | `id` |

### HealthCollector

Collects system-level health metrics on every request from the server:

| Metric | Range | Description |
|---|---|---|
| `cpuLoad` | 0 – ∞ | 1-minute load average divided by CPU count (>1 = overloaded) |
| `memFree` | 0 – 1 | Free memory fraction |
| `activeSessions` | 0 – ∞ | Number of active HLS transcode sessions |

The browser uses these metrics together with tunnel RTT to score proxies:

```
score = memFree × 0.4 + (1 - clamp(cpuLoad, 0, 1)) × 0.4 − (rttMs / 2000) × 0.2
```

### HlsSessionManager & ffmpeg

Creates and manages ffmpeg-based HLS transcode sessions. Sessions are keyed by `sourceKey:fileIndex:mode` and shared across consumers.

```mermaid
sequenceDiagram
  participant B as Browser (via DataChannel)
  participant H as HlsSessionManager
  participant F as ffmpeg

  B->>H: POST /api/transcode-sessions (consumerId, mode)
  H->>F: start (or reuse) ffmpeg process
  H-->>B: { sessionId, playlistPath }

  loop segment requests
    B->>H: GET /transcode/:sessionId/seg000.ts
    H-->>B: MPEG-TS segment (via data channel chunk)
  end

  B->>H: GET /api/transcode-sessions/:id/progress
  H-->>B: { percent, speed, remainingSeconds, … }

  B->>H: POST /api/transcode-sessions/:id/release (consumerId)
  H->>H: remove consumer
  alt last consumer released
    H->>F: kill process + cleanup segments
  end
```

## HTTP API

Base URL examples use `http://127.0.0.1:9090`.

### Health

```bash
GET /health
GET /healthz
```

### Register a source

```bash
POST /api/sources
Content-Type: application/json

{
  "sourceType": "magnet",         # or "torrent" (base64-encoded bytes)
  "source": "magnet:?xt=urn:btih:…"
}
```

Response: `{ "sourceKey": "…" }`

### Build playback plan

```bash
POST /api/playback-plan
Content-Type: application/json

{
  "sourceKey": "<sourceKey>",
  "fileIndex": 0,
  "userAgent": "Mozilla/5.0 …"
}
```

Response:

```json
{
  "mode": "direct",
  "directUrl": "http://127.0.0.1:9090/stream?sourceKey=…&fileIndex=0",
  "reason": "audio-codec-supported",
  "audioCodec": "aac",
  "videoCodec": "h264"
}
```

`mode` is `"direct"` or `"hls"`.

### Direct stream

```bash
GET /stream?sourceKey=<key>&fileIndex=0
```

Supports HTTP Range requests.

### Create HLS transcode session

```bash
POST /api/transcode-sessions
Content-Type: application/json

{
  "sourceKey": "<key>",
  "fileIndex": 0,
  "transcodeVideo": false,
  "consumerId": "uuid",
  "fileName": "Episode01.mkv"
}
```

Response: `{ "sessionId": "…", "playlistPath": "/transcode/<id>/index.m3u8" }`

### Poll transcode progress

```bash
GET /api/transcode-sessions/:sessionId/progress
```

Returns: `percent`, `processedSeconds`, `totalSeconds`, `remainingSeconds`, `speed`, `warmupPercent`, `warmupRemainingSeconds`.

### Release consumer

```bash
POST /api/transcode-sessions/:sessionId/release
Content-Type: application/json

{ "consumerId": "uuid", "reason": "pagehide" }
```

When the last consumer is released, the transcode session stops and temp files are cleaned up.

## Requirements

- Node.js 18+ (ESM, built-in `fetch`).
- ffmpeg is required only when transcoding is enabled (bundled via `ffmpeg-static` by default).

## Run

```bash
npm install
npm start -- --server-url http://localhost:3000
```

### CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--server-url` | — | **(Required)** Base URL of the registry server |
| `--host` | `127.0.0.1` | Bind host |
| `--port` | `9090` | Preferred local port (auto-increments if taken) |
| `--public-base-url` | — | Externally reachable base URL advertised to registry |
| `--id` | auto | Stable proxy client ID |
| `--name` | hostname | Display name in registry |
| `--token` | — | Auth token for register/heartbeat |
| `--ffmpeg-bin` | bundled | Path to custom ffmpeg binary |
| `--no-transcode-audio` | — | Disable HLS audio transcoding |
| `--help` | — | Print all options and exit |

## Docker

```bash
docker build -t torrent-tv-proxy .
docker run torrent-tv-proxy --server-url http://my-server:8080
```

## Full End-to-End Flow

```mermaid
sequenceDiagram
  participant B as Browser
  participant S as Registry Server
  participant P as Proxy

  Note over P,S: Startup
  P->>S: POST /api/proxy-clients/register
  P->>S: WebSocket /ws/proxy-tunnel (persistent)

  Note over B,P: Playback start
  B->>S: GET /api/proxy-clients/health
  S->>P: health-request via tunnel
  P-->>S: health-response (cpu, mem, activeSessions)
  S-->>B: scored proxy list

  Note over B,P: WebRTC setup
  B->>S: WebSocket /ws/browser-signal
  B->>B: RTCPeerConnection + DataChannel + createOffer
  B->>S: { type:"offer", proxyId, sdp }
  S->>P: forward via tunnel
  P->>P: createAnswer
  P->>S: { type:"answer", sdp }
  S->>B: forward
  Note over B,P: ICE candidates exchanged same way
  Note over B,P: Data channel opens (P2P, STUN-assisted)

  Note over B,P: Streaming
  B->>P: request via data channel: POST /api/sources
  P-->>B: response-chunk: { sourceKey }
  B->>P: request via data channel: POST /api/playback-plan
  P-->>B: response-chunk: { mode, audioCodec, videoCodec, … }
  B->>P: request via data channel: POST /api/transcode-sessions
  P-->>B: response-chunk: { sessionId, playlistPath }
  B->>P: HLS.js fetches: GET /transcode/:id/index.m3u8
  B->>P: HLS.js fetches: GET /transcode/:id/seg000.ts …
  Note over B,P: All via data channel — no server relay
```

## Notes

- HLS session temp files are in the OS temp directory and cleaned up automatically.
- Transcode sessions are cached by `sourceKey:fileIndex:mode` and shared across consumers.
- The source registry is in-memory and bounded (old entries evicted).
- The proxy reconnects to the server automatically on tunnel disconnect.

## License

GPL-3.0-or-later (see `LICENSE`). Third-party dependencies keep their own licenses.
Bundled ffmpeg binaries (`ffmpeg-static`) are GPL-compatible.
