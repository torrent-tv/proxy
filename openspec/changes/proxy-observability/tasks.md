# Tasks: Proxy observability

## 1. Implementation

- [x] 1.1 Version in `/healthz` and `/health` (createRequire package.json in
      server.js, passed as route dep)
- [x] 1.2 torrent-pool.js: added-torrent line (files/private/trackers),
      torrent `warning` logging, tracker `update` (announce seeders/leechers)
      logging with defensive access, client-level warning logging
- [x] 1.3 port-mapper.js: setMaxListeners(0) on the UPnP SSDP emitter after
      the first successful map()
- [x] 1.4 Syntax checks + healthz handler smoke test (version present)

## 2. Release

- [x] 2.1 CHANGELOG.md entry at 2.9.25
- [ ] 2.2 `npm run patch` (needs npm auth), then ha-addon bump 0.2.47 + push
- [ ] 2.3 After the addon updates: verify version via `/healthz`, watch the
      addon log for announce lines on a real torrent, confirm no SSDP
      warnings
