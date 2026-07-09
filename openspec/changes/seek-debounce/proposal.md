# Proposal: Debounce server-side seek restarts

## Why

Field evidence (iPhone/Safari, Poirot, 2026-07-09): after a scrub the player
hung indefinitely. The proxy restarts ffmpeg at a requested segment when the
request lands outside the look-ahead window (server-side seek). The native
iOS player issued scattered segment requests after the seek —
`367 → 732 → 369 → 368 → 370` — each 25–35 s apart. The existing guard
(`RESTART_COOLDOWN_MS = 4000`) only suppresses restarts within 4 s of the
last one, so with requests spaced far wider than that, EVERY scattered
request restarted ffmpeg at a new position. ffmpeg ping-ponged between
positions and never finished a single segment, so playback stalled at
`currentTime` with `bufferedAhead=0` — "заглохло наглухо".

The fix is the user's idea placed where every client is covered (including
the iOS native fullscreen player, whose scrubber the web app cannot control):
don't act on the first far request — wait for the burst to settle, then
restart ONCE at the position the player ended on.

## What Changes

- Replace the fixed post-restart cooldown as the anti-thrash mechanism with a
  **settle window**. When a segment request lands outside the look-ahead
  window (a seek), the proxy does NOT restart immediately: it records the
  requested index as the pending seek target and arms a short quiet-period
  timer. Each further far request updates the target to the latest index and
  re-arms the timer (debounce). When the quiet period elapses with no new far
  request, ffmpeg restarts ONCE at the pending target. A hard cap bounds the
  total wait so a genuine seek is never delayed more than a fixed budget even
  while the scrubber is still moving.
- Meanwhile the segment route behaves exactly as today — it long-polls and
  the client retries — so the player simply waits out the (short) settle
  instead of driving restarts.
- "Last far index wins" self-corrects: if the settle resolves on the wrong
  position (e.g. a lone probe request), the player's next request re-arms one
  more settle — at most one extra cycle, never the old infinite ping-pong.

Out of scope (documented in design.md): an optional client-side scrubber
debounce for the in-page media-chrome control (helps responsiveness but does
NOT cover iOS native fullscreen, so the proxy-side settle is the must-have);
the cold-torrent piece-download and weak-host encode latency that make the
FIRST post-seek segment slow regardless — the settle removes the infinite
thrash, not the one-time seek latency.

## Capabilities

### Modified Capabilities

- `seek-debounce` (server-side HLS seeking): far-segment requests are
  debounced into a single ffmpeg restart at the settled position.

## Impact

- `services/hls-session-manager.js` — `#ensureEncodingFor` gains the settle
  window; per-session settle state; `disposeSession` clears the timer;
  constants. `RESTART_COOLDOWN_MS` is retained only as a minimum gap between
  actual restarts.
- Proxy release + ha-addon version bump (per release rules).
