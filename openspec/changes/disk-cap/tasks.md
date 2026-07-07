# Tasks: Global disk cap with LRU eviction

## 1. Implementation

- [x] 1.1 Access tracking (`#lastAccess`) updated on getTorrent (incl. the
      duplicate-infoHash path) and acquireFile
- [x] 1.2 Cap computed at construction (`min(10GB, half free)` via statfs) or
      taken from the `maxDiskBytes` option; 0 disables
- [x] 1.3 Periodic (30 s) `#enforceDiskCap`: evict zero-reader torrents
      LRU-first via the existing remove-with-store path; clear timer on
      destroyAll; drop `#lastAccess` on removal
- [x] 1.4 `--max-disk-bytes` CLI flag → server.js → pool
- [x] 1.5 Syntax checks + unit-test the eviction ordering/active-skip

## 2. Release

- [ ] 2.1 Ship in the proxy batch (2.9.29) + ha-addon bump
- [ ] 2.2 Field-check on the host: open several large files, confirm idle
      ones are evicted and playback is never interrupted
