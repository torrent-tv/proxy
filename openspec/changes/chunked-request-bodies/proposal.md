# Proposal: Chunked request bodies over the data channel (proxy side)

## Why

The browser sends every request as ONE data-channel message, body included.
Registering a source carries the base64-encoded `.torrent` as that body — a
big multi-season pack (Poirot, 13 seasons: 420 KB `.torrent` → ~560 KB
base64) exceeded libdatachannel's default advertised `a=max-message-size`
of 256 KB, so the browser's `send()` threw "Trying to send message larger
than max-message-size" and playback dead-ended.

The committed-but-unpublished stopgap (advertise 16 MB, pending 2.9.35)
lifts the ceiling but keeps the flaw: any single-message body still has a
hard cap, and a large message is buffered whole on both ends. Responses
already solved this properly — they stream as small binary frames. Requests
should be symmetric.

## What Changes

- **Inbound binary body frames.** The proxy accepts request bodies as
  binary frames with EXACTLY the response-frame layout
  (`[flags][idLen][requestId][payload]`, bit 0 = done; new bit 1 = aborted),
  announced by a new `{type:"request-start", …, bodyBytes}` control message.
  On the done frame the assembled body runs through the SAME request
  execution path as a legacy request. Bounded: per-body cap 32 MB, partial
  bodies dropped after a 60 s TTL or an abort frame, all per-channel state
  freed on channel close.
- **No capability negotiation.** POC: the pool is one proxy, released in
  lockstep with the site (proxy first, then server). The browser just uses
  chunked frames for large bodies; this proxy just understands them.
- **The 16 MB `max-message-size` advertisement (pending 2.9.35) stays** —
  a single config value, no logic: it covers the transition window while
  already-open tabs still run the single-send bundle.
- **Observability**: the `[dc]` request log line reports chunked bodies
  (`body=<bytes> bytes (chunked)`).

Browser-side counterpart (chunk writer, threshold, backpressure, abort) is
the server repo's `chunked-request-bodies` change. Release order: proxy
(with addon bump) FIRST, then server.

## Capabilities

### New Capabilities

- `chunked-request-bodies`: request-body transport over the data channel.

## Impact

- `services/data-channel-handler.js` — binary inbound frame parsing;
  per-channel partial-body assembly with caps/TTL; `request-start`
  handling; shared execution path.
- Release: folds into the PENDING proxy 2.9.35 (extend its CHANGELOG entry;
  do not create a new version) + ha-addon 0.2.56 (same rule).
