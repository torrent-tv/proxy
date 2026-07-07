# Proposal: Global disk cap with LRU eviction (Disk hygiene Level 1, final)

## Why

Downloaded torrent data is already removed on a 300 s idle TTL and at
shutdown, and orphans are swept at startup — but under pressure (several
large files opened within the TTL window, or a fast fill) the total can
still grow unbounded and fill a small Home Assistant host's disk
(SD/eMMC on a Yellow/Pi is often 16–32 GB). A full disk can take down Home
Assistant itself. This adds the last missing Level 1 piece: a global cap.

## What Changes

- The pool tracks total downloaded bytes and, when it exceeds a cap, evicts
  whole torrents with NO active reader, least-recently-used first, until
  back under the cap (checked every 30 s and reused via the existing
  remove-with-store path). A torrent that is currently playing is never
  evicted — we cannot delete what is in use.
- The cap defaults to `min(10 GB, half of free disk)` (measured via
  `statfs` on the store filesystem), and is overridable with
  `--max-disk-bytes` (0 disables).

## Capabilities

### New Capabilities

- `disk-cap`: bounded total on-disk footprint via LRU eviction.

### Modified Capabilities

<!-- none -->

## Impact

- `services/torrent-pool.js` (access tracking, cap enforcement),
  `bin/cli.js` (`--max-disk-bytes`), `server.js` (option pass-through);
  ha-addon bump. Part of the proxy transcode/hygiene batch (2.9.29).
