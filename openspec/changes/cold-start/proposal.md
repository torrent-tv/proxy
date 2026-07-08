# Proposal: Cold-start reduction (proxy side)

## Why

Field recordings (mobile tester, 2026-07-08) show ~90 seconds from picking an
episode to a picture. The proxy owns two chunks of that:

1. **A redundant ffmpeg input scan.** The playback planner probes the input
   (`probeStreamCodecs`) and CACHES the plan — then `createSession` in
   hls-session-manager immediately probes the SAME input again
   (`probeInputMediaInfo`) for duration/resolution/fps/startTime/HDR. Each
   probe is a full ffmpeg startup + banner scan over the torrent-backed HTTP
   stream — seconds on the HA host, on the critical path, twice.
2. **First-segment piece latency.** The planner prefetches only the file
   EDGES (256 KB head + 2 MB tail — what the codec probe needs). The first
   segment's encode then needs the first ~10–20 MB of the file BODY, whose
   pieces start downloading only when ffmpeg asks for them — while the swarm
   sat mostly idle during the plan poll.

There is also no per-stage timing in the logs, so field regressions in
session startup are invisible.

## What Changes

- **Reuse the planner's probe in session create.** The planner parses and
  caches the full media info (duration, width/height, fps, startTime, isHdr)
  from the probe it already runs; hls-session-manager consults that cache
  and skips its own `probeInputMediaInfo` on a hit (probe stays as the
  fallback). One full ffmpeg scan disappears from the critical path.
- **Prefetch the file-body start once the plan is ready.** After a successful
  probe, fire-and-forget prefetch of the first 16 MB of the file, so the
  session's ffmpeg reads hit already-downloaded data instead of paying piece
  latency at encode time.
- **Stage timings in the log.** Session create logs probe ms (and
  cache-hit/probed), keyframe-probe ms, and the time from create to the
  first servable segment — so cold-start is measurable per stage in the
  field, next to the client-side summary line (server `cold-start` change).

Client-side counterparts (phase instrumentation, earlier prebuffer start)
live in the server repo's `cold-start` change. The two changes are
independent — no wire-format coupling, either releases alone.

NOT in this change (candidates for later, kept out deliberately):
next-episode speculative prefetch (bandwidth cost needs field data first);
encoder-side first-segment speed-ups (faster warm-up preset would need a
mid-stream switch — parked with transcode-quality 2.2b).

## Capabilities

### New Capabilities

- `cold-start`: proxy-side session startup latency behaviour.

## Impact

- `services/playback-planner.js` — parse + cache full media info; expose
  `getCachedMediaInfo`; body-start prefetch after a successful probe.
- `services/hls-session-manager.js` — consult the cache in `createSession`;
  stage-timing log lines.
- `server.js` — wire `getCachedMediaInfo` into the HlsSessionManager deps.
- Release: proxy `npm run patch` + ha-addon version bump (standard order:
  proxy first, then addon).
