# Design: Proxy observability

## Context

Diagnosing the 2026-07-06 failures required docker exec into the addon
container (version) and offered no explanation for zero-peer torrents.
See proposal for the three gaps.

## Goals / Non-Goals

**Goals:** remote version visibility; explainable zero-peer torrents; clean
logs.

**Non-Goals:** peer-origin tags in `[stats]` (tracker/DHT/PEX attribution is
not cheaply available on WebTorrent's public API — dropped from the original
proposal scope); structured/queryable log output.

## Decisions

1. **Version via createRequire of package.json** (same pattern as the server
   repo), passed as a route dep — no version literal to forget on release.
2. **Announce results from `torrent.discovery.tracker` ("update" event)** —
   internal WebTorrent API, therefore guarded with optional chaining and a
   fallback log line when absent; a breaking WebTorrent upgrade degrades to
   "not logged", never to a crash. Torrent-level `warning` events carry
   tracker rejections/errors and are a public API.
3. **SSDP fix = setMaxListeners(0) on the one emitter** right after the
   first successful map() (the UPnP client is created lazily by it).
   Alternatives rejected: raising EventEmitter.defaultMaxListeners (global,
   hides real leaks elsewhere); one shared NatAPI for both mappers (couples
   TCP/UDP lifecycles for no gain).

## Risks / Trade-offs

- [Announce logging depends on WebTorrent internals] → defensive access +
  explicit fallback line; covered by the spec's best-effort clause.
- [Announce lines add log volume] → one line per announce interval
  (minutes), negligible next to the existing [stats] cadence.
