# Design: Chunked request bodies (proxy side)

Written to be executed as specified — the wire format, constants, limits
and do-NOT list are normative. Read before coding:

- `services/data-channel-handler.js`: the whole file — the wire-protocol
  doc comment (~lines 9–37), `handleChannel` (onMessage string handling),
  `handleRequest`, `sendChunk` (the response frame writer whose layout the
  request frames mirror), `send`.
- `services/webrtc-manager.js`: where `onDataChannel` hands the channel to
  the handler (hello is sent from the handler's `handleChannel`, at wire-up
  time — the channel is already open when it is delivered).
- `routes/healthz/get.js` or `bin/cli.js`: how the proxy version string is
  obtained today (reuse the same mechanism; do not re-read package.json in
  a second way).

## Wire protocol (additions)

Existing messages are UNCHANGED. New:

    Proxy → Browser, once, immediately at channel wire-up:
      { type: "hello", proto: 1, version: "<proxy version>",
        maxRequestBytes: 33554432 }

    Browser → Proxy, announcing a chunked request:
      { type: "request-start", requestId, method, path, query, headers,
        bodyBytes }          // bodyBytes = exact total body size in bytes

    Browser → Proxy, body frames (BINARY messages — today the proxy only
    ever receives strings, so binary is unambiguous):
      byte 0        flags     bit 0: done (last frame)
                              bit 1: aborted (drop this request, no reply)
      byte 1        idLen     requestId length in bytes
      bytes 2..2+N  requestId (ASCII)
      bytes 2+N..   payload   raw body bytes (UTF-8 of the body string;
                              may be empty on a done/abort frame)

Identical layout to the response frames (`sendChunk`) — one mental model,
and the browser already has a builder/parser for it.

## Constants

    PROXY_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024
    PARTIAL_REQUEST_TTL_MS = 60_000

## Assembly (all state per channel, inside `handleChannel`'s closure)

    const partials = new Map(); // requestId → { meta, chunks: [], receivedBytes, timer }

- `request-start`: validate like a legacy request (same path allowlist —
  run the SAME validation before accepting the body; reject with
  `response-error` immediately on a bad path). Reject `bodyBytes` >
  PROXY_MAX_REQUEST_BODY_BYTES with `response-error` "Request body too
  large." and do NOT create state. Otherwise store `{ meta, chunks: [],
  receivedBytes: 0 }` and arm the TTL timer.
- Binary frame: parse header; unknown requestId → ignore (stale/aborted).
  bit 1 (aborted) → clear timer, delete entry, no reply. Append payload,
  add to receivedBytes; receivedBytes > bodyBytes (or > the cap) →
  `response-error` + drop. bit 0 (done): concat chunks → body string via
  `Buffer.concat(...).toString("utf8")`; receivedBytes !== bodyBytes →
  `response-error` "Request body size mismatch." and drop; else clear
  timer, delete entry, and execute through the SAME code path a legacy
  `request` message takes (factor `handleRequest` so both entry points
  call one function with `{requestId, method, path, query, headers, body}`).
- TTL fire: delete entry, log
  `[dc] Session …: dropped stale partial request <id8> (<receivedBytes>B)`.
- `channel.onClosed`: clear ALL timers and the map (extend the existing
  handler — do not replace its logging).

## Hello

Sent from `handleChannel` right after the handlers are wired (the channel
is open by the time `onDataChannel` delivers it — same reason the existing
code can log "channel open" there). Use the same version source healthz
uses. `send()` failure is non-fatal (log and continue) — an old browser
simply ignores the unknown JSON type by design.

## Logging

- Chunked request execution logs the SAME `[dc] <method> <path>` line as
  legacy, with `body=<bytes> bytes (chunked)`.
- Hello logs once per channel: `[dc] Session …: hello sent (v<version>)`.

## Rules — do NOT

- Do NOT change the legacy `{type:"request"}` handling, the response
  framing, ping/pong, or the path allowlist semantics.
- Do NOT revert the 16 MB `maxMessageSize` advertisement in
  webrtc-manager.js (pending 2.9.35) — it is the compatibility path for
  old cached browser bundles.
- Do NOT hold partial bodies beyond the TTL or channel lifetime; no global
  (cross-channel) state.
- Do NOT create a new proxy version: fold into the pending 2.9.35
  CHANGELOG entry (accumulate bullets, per the versioning rules) and the
  pending addon 0.2.56 entry.
