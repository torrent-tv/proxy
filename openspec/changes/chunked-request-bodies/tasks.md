# Tasks: Chunked request bodies (proxy side)

Execute in order; design.md is normative. Read the code regions listed at
its top first.

## 1. Implementation

- [ ] 1.1 `data-channel-handler.js`: factor the execution tail of
      `handleRequest` so a legacy `request` message and an assembled
      chunked request run the SAME function. `node --check`.
- [ ] 1.2 Hello: send `{type:"hello", proto:1, version, maxRequestBytes}`
      at channel wire-up (version from the same source healthz uses);
      non-fatal on failure; log once per channel.
- [ ] 1.3 `request-start` + binary inbound frames + per-channel assembly
      with cap (32 MB), size-mismatch check, abort flag (bit 1), TTL
      (60 s), cleanup on channel close. Unknown-requestId frames ignored.
- [ ] 1.4 Logging: `body=<bytes> bytes (chunked)` on execution; stale-drop
      line on TTL.

## 2. Verification

- [ ] 2.1 Node loopback test (two node-datachannel PeerConnections in one
      script, like the SDP test): drive a request-start + 64 KB frames of a
      ~600 KB body through a real channel into a handler instance wired to
      a stub local server; assert the assembled body bytes match and a
      response comes back. Also: abort frame → no reply, state dropped;
      oversized announcement → response-error.
- [ ] 2.2 Legacy regression: single-message request path byte-identical
      behaviour (run an existing small request through both entry points).
- [ ] 2.3 E2E (after the server-side change lands in preview): local stack
      — preview server + local proxy (`node bin/cli.js --server-url
      ws://localhost:8080`), register the real Poirot `.torrent`
      (C:\Users\AntonNemtsev\Downloads\Пуаро_…​.torrent, ~560 KB base64)
      via the UI; plan returns; `[dc] … body=… (chunked)` in the proxy log.

## 3. Release

- [ ] 3.1 EXTEND the pending 2.9.35 CHANGELOG entry (do not bump again) and
      the pending addon 0.2.56 entry.
- [ ] 3.2 `npm run patch` in proxy (publishes 2.9.35), push addon bump,
      update the addon in HA; verify `Starting @torrent-tv/proxy v2.9.35`
      in the addon log. Proxy FIRST, then addon, then the server-side
      change releases independently.
