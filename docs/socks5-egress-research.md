# SOCKS5 torrent egress — feasibility research (NOT implemented)

Research only (2026-07-10), no code. Question: can the proxy route its
**torrent** traffic (peers, trackers, DHT) through an owner-configured SOCKS5
endpoint (e.g. a VPN provider's) to hide the owner's home IP from the swarm,
while WebRTC to the viewer stays direct? Roadmap item 8 in the root
`CLAUDE.md`.

Stack: WebTorrent 2.8.5, Node. Verified against
`node_modules/webtorrent/lib/*.js` and `index.js`.

## What "torrent traffic" actually is (and which parts can be SOCKS5'd)

SOCKS5 forwards a connection through a relay so the destination sees the
relay's IP, not ours. It supports TCP (CONNECT) and, in theory, UDP (UDP
ASSOCIATE) — but UDP-ASSOCIATE is rarely usable from Node libraries that bind
their own UDP sockets. So per traffic type:

| Traffic | Transport | Where in WebTorrent | SOCKS5? |
|---|---|---|---|
| Peer wire (outgoing) | TCP | `torrent.js` `net.connect(opts)` (~L2112) | **Yes** (TCP CONNECT) |
| Peer wire (outgoing) | µTP (UDP) | `torrent.js` `utp.connect()` (~L2110) | No (UDP, own socket) → **disable** |
| HTTP/HTTPS trackers | TCP | `bittorrent-tracker` (HTTP agent) | **Yes** (agent) |
| WSS trackers | TCP (WebSocket) | `bittorrent-tracker` (ws agent) | **Yes** (agent) |
| UDP trackers (`udp://`) | UDP | `bittorrent-tracker` | No → **drop** (filter announce list) |
| DHT | UDP | `bittorrent-dht` | No → **disable** (`dht:false`) |
| LSD (local peer discovery) | UDP multicast | conn-pool | LAN-only leak → **disable** (`lsd:false`) |
| Incoming peers | TCP/µTP listener | conn-pool | N/A (inbound; see note) |

Conclusion: a clean, leak-free config is **TCP-only through the SOCKS5 relay**
with every UDP path turned OFF. This is the standard "torrent proxy" model and
its standard caveat: you lose µTP peers, UDP trackers, and DHT peer discovery —
peer counts drop, but HTTP/WSS-tracker swarms (like the rutracker trackers our
test torrents use) still work, and TCP peers are plentiful.

WebTorrent already exposes the needed off-switches (verified in `index.js`):
`utp: false` (L82), `dht: false` (L127), `lsd: false` (L76), `webSeeds`
(L161). Announce-list filtering to `http(s)://`/`wss://` is ours to do.

## The hard part: no dialer hook for TCP peers

WebTorrent has **no public option** to supply a custom socket/dialer for
outgoing peer connections — it calls `net.connect(opts)` directly inside
`torrent.js`. Three ways around it:

### Approach A — userland, scoped monkeypatch of `net.connect` (+ disable UDP)
Wrap `net.connect` so that for a **peer destination** it returns a socket
tunneled through SOCKS5 (via the already-present `socks` package —
`SocksClient.createConnection({ proxy, command:'connect', destination })`),
and for everything else (our loopback HTTP server, the signalling tunnel,
ffmpeg's `127.0.0.1` fetch, DNS) it calls the real `net.connect`.
- The `socks` dep is ALREADY in `node_modules` (currently transitive) — would
  become a direct dependency.
- Shim detail: `net.connect` returns a socket synchronously and connects
  async; `SocksClient.createConnection` is Promise-based. Need a small adapter
  that returns a `net.Socket`-like duplex immediately and attaches the real
  tunneled socket once the SOCKS handshake resolves (or emits `error`). The
  `socks` package's event API supports this.
- Scoping rule: SOCKS only for non-local IPv4/IPv6 destinations; NEVER for
  `127.0.0.1`/`::1`/the tunnel host — otherwise we'd route our own control
  plane through the VPN.
- Trackers/webseeds (HTTP/WSS): pass a `socks-proxy-agent` as the HTTP/ws
  agent to `bittorrent-tracker` / webseed fetches (need to confirm WebTorrent
  threads an `agent` option through; may need a small patch).
- Pros: no fork, no build-chain changes, deployment-agnostic. Cons: global
  monkeypatch is delicate; must be airtight on the scoping rule.

### Approach B — patch/fork WebTorrent to add a `createConnection` hook
Add an option so `torrent.js` uses `opts.createConnection ?? net.connect`.
Cleaner and explicit, but a fork to maintain (or an upstream PR — issue
webtorrent#807 "SOCKS Proxy Support" is open and unresolved, so upstream is
unlikely soon). More correct long-term if A proves too fragile.

### Approach C — network-level (VPN container / namespace), NOT in-proxy
Run the whole proxy process behind a VPN with a kill-switch (e.g. a `gluetun`
sidecar container, or a Linux network namespace bound to the VPN). Catches
ALL traffic — TCP, µTP, DHT, UDP trackers — leak-proof, zero proxy code.
Trade-off: not per-app (the whole proxy egresses via VPN, including the
signalling tunnel unless split), heavier ops, and awkward for the HA addon
(`host_network: true`). This is the ROBUST alternative to document alongside;
for a bare-Docker/npm operator it may actually be the better answer than
in-proxy SOCKS5.

## Kill-switch (fail-closed) — mandatory for the feature to mean anything
If the SOCKS5 relay is down, torrent traffic must NOT silently fall back to a
direct connection (that leaks the exact IP we set out to hide). With Approach
A this is natural: a failed SOCKS handshake fails the peer connection with no
direct retry, AND all UDP paths are already disabled, so nothing bypasses the
relay. Must add a startup connectivity self-test + a clear log line
(BitPlay's "test proxy" pattern), and surface "proxy down → torrent paused"
rather than leaking.

## Recommended direction (when we build it)
1. Primary: **Approach A** — `socks` for TCP peers via a scoped `net.connect`
   shim + `socks-proxy-agent` for HTTP/WSS trackers + webseeds, with
   `utp:false`, `dht:false`, `lsd:false`, and announce-list filtered to
   TCP-based trackers. Fail-closed by construction.
2. Document **Approach C** (VPN container) in the addon/deployment docs as the
   leak-proof alternative for operators who prefer it.
3. Approach B only if A's monkeypatch proves too fragile in practice.

## Open questions to resolve at build time (not now)
- Does WebTorrent 2.8.x thread an `agent`/proxy option to `bittorrent-tracker`
  and webseed fetches, or is a small patch needed there too?
- `socks` socket-shim: cleanest way to present a pre-connect `net.Socket`
  (custom Duplex vs a paused real socket) without confusing
  `bittorrent-protocol`'s wire setup.
- Incoming peers: with UDP off and outbound via SOCKS, do we still accept
  inbound TCP peers directly (that inbound listener exposes the home IP to
  connecting peers)? For full hiding, inbound may need to be disabled too
  (accept that peer discovery becomes outbound-only) — decide per privacy goal.
- Interaction with the UPnP port mapping / WebRTC UDP port (those are for the
  viewer transport, NOT torrent egress — must stay direct; confirm the shim's
  scoping never touches them).
