## 2.5.7

- **Fix**: WebRTC connection failure behind symmetric NAT — all ICE candidates (private and public) are now sent to the browser immediately. The browser attempts all paths in parallel; the local LAN path succeeds when browser and proxy are on the same network. Chrome's Private Network Access dialog appears once on first connect.

## 2.5.6

- **Fix**: ICE candidate filtering — private host candidates (RFC 1918, Docker bridge IPs, IPv6 ULA/loopback) are now buffered and suppressed when a public srflx candidate is available. This eliminates the Chrome/Brave Private Network Access permission dialog when connecting from a page served over HTTPS. Falls back to private candidates if no public srflx candidate is gathered (e.g. STUN unreachable), so connectivity is preserved at the cost of the PNA dialog.

## 2.5.5

- **Fix**: Tunnel keepalive — proxy now sends a WebSocket ping to the server every 30 s to prevent Cloudflare's ~100 s idle-connection timeout from dropping the tunnel.

## 2.5.3

- Internal: improved tunnel reconnect logic and error logging.

## 2.0.0

- **New**: WebRTC P2P tunnel architecture — replaced direct HTTP streaming with a persistent WebSocket tunnel to the server. Video is delivered from the proxy to the browser over a WebRTC data channel; the server acts only as a signalling relay.
- **New**: `node-datachannel` dependency for server-side WebRTC.
- **Removed**: `public_base_url` config — no longer needed.
