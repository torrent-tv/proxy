# Proposal: Forward relayed requests to the local proxy server in one place

Issue: torrent-tv/meta#281 (sub-issue 16.01 of #279; parent change
`one-way-per-task`).

## Problem

A request that arrives from outside the proxy is turned into an HTTP call to
the proxy's own Fastify server (`127.0.0.1:<port>`) in two places, with
different guards:

1. The WebRTC data channel (`services/transport/data-channel-handler.js`,
   `forwardRequest`) refuses paths outside the browser's route set, caps a
   chunked body at 32 MiB, aborts the local call when the browser cancels and
   uses an undici dispatcher with no header/body timeouts.
2. The server tunnel (`services/transport/tunnel-client.js`,
   `handleRelayRequest`) has none of this: any path, any body size, no abort,
   undici's default 300 s timeouts, and a body that fails half-way is
   reported as `done: true`, so a cut-off answer looks complete.

Every forwarded call comes from 127.0.0.1, so routes that trust loopback
(`/encode-input/*`, `/media`) accept anything the tunnel forwards. On the
server, `services/proxy-tunnel-server.js` `relay()` has no caller (checked on
server `origin/main` cb5d277: `git grep "relay("` finds only its definition),
so the tunnel copy serves nobody and only widens what a tunnel peer can reach.

## Why it matters

- To the viewer: nothing visible changes — the browser already uses only the
  data channel. The film opens, seeks and switches soundtrack as before.
- To us: one owner for "forward a relayed request to loopback" means one place
  for the allowlist, the body cap and the timeout policy. The loopback-only
  routes stay reachable only from the proxy's own process, not from any
  tunnel peer.

## What changes

- New `services/transport/loopback-forward.js` owns the path allowlist, the
  body cap, the zero-timeout dispatcher and the single `fetch` to loopback.
- `data-channel-handler.js` calls it; `forwardRequest` keeps only framing,
  logging and back-pressure.
- The tunnel relay is deleted on both sides: proxy `handleRelayRequest` and its
  `"request"` branch; server `relay()` and everything only it uses.

## Out of scope

SCTP framing, the send-queue watcher, signalling, the chapters URL parsing in
the data channel, the `[net-debug]` / `[forecast-http]` lines (they stay as
they are), the logger port (#305).
