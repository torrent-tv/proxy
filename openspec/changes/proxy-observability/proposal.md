# Proposal: Proxy observability (queued for the next proxy release, 2.9.25)

## Why

Three diagnosis gaps surfaced while debugging the 2026-07-06 mobile playback
failures:

1. `/healthz` and `/health` return only `{"ok":true}` — there is no way to
   see the running proxy version remotely (the addon shipped a stale proxy
   for a whole release and nothing detected it). The server already returns
   `version` in its healthz; the proxy should match.
2. Tracker announces are silent: a torrent with zero peers gives no clue
   whether the tracker rejected the announce (e.g. a private tracker's
   client whitelist), returned an empty peer list, or was unreachable.
   WebTorrent surfaces these as `warning` events that nothing logs.
3. `MaxListenersExceededWarning` for `[Ssdp]` floods the log — the two
   port-mapper instances (TCP + UDP) plus WebTorrent's own nat-api attach
   listeners to a shared SSDP emitter.

## What Changes

- `/healthz` and `/health` include the proxy `version` (from package.json),
  keeping the current `ok` semantics.
- Torrent-level `warning` events (tracker errors and rejections) are logged;
  each tracker announce result is logged with the peer count returned.
  Where cheaply available, peer origin (tracker / DHT / PEX) is tagged in
  the existing `[stats]` line.
- SSDP listener leak fixed (raise the max-listeners on the shared emitter or
  share one discovery instance between the two port mappers).

## Capabilities

### New Capabilities

- `observability`: health/version reporting and peer-discovery diagnostics.

### Modified Capabilities

<!-- none yet — openspec/specs is empty in this repo -->

## Impact

- `routes/healthz/get.js`, `routes/health/get.js` (or their handlers) —
  version field.
- `services/torrent-pool.js` — warning/announce logging, stats origin tags.
- `services/port-mapper.js` — SSDP listener fix.
- CHANGELOG entry at current package.json version + 1 patch (2.9.25);
  requires the usual ha-addon version bump (0.2.47) after `npm run patch`
  (npm publish needs the user's npm key).
