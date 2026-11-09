# Design: loopback-forward

Normative for #281. Line numbers are at proxy `origin/main` 2b58e9b4 and server
`origin/main` cb5d277; re-locate by name.

## 1. `services/transport/loopback-forward.js` (new, proxy)

May import only `undici`, Node built-ins and `../../utils/**` (biome layer rule
for `services/transport/**`). Exports:

```js
/** Max size of a forwarded request body, in bytes (32 MiB). */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/**
 * True when `path` is a string, starts with "/", contains no "..", and matches
 * the browser route set: /api/*, /stream, /transcode/*, /health, /healthz
 * (the regex moved unchanged from data-channel-handler.js:
 * /^(?:\/api\/|\/stream(?:$|\?)|\/?transcode\/|\/health(?:z)?(?:$|\?))/).
 */
export function isValidRequestPath(path) {}

/** Thrown before any connection is opened when a request is refused. */
export class LoopbackRefusal extends Error {} // name "LoopbackRefusal"

/**
 * Forward one relayed request to the local proxy server.
 *
 * @param {object} request
 * @param {number} request.port        local Fastify port
 * @param {string} request.requestId   sent as x-ttv-forwarded-request-id
 * @param {string} request.method
 * @param {string} request.path
 * @param {string} [request.query]     without the leading "?"
 * @param {Record<string,string>} [request.headers]
 * @param {string | Buffer | null} [request.body]
 * @param {AbortSignal} request.signal
 * @returns {Promise<Response>}        the undici fetch Response, unread
 */
export async function forwardToLoopback(request) {}
```

Behaviour of `forwardToLoopback`:

1. Path not valid by `isValidRequestPath` → rejects with
   `LoopbackRefusal("Invalid request path.")`; no connection is opened.
2. Body whose byte length (`Buffer.byteLength`) exceeds
   `MAX_REQUEST_BODY_BYTES` → rejects with
   `LoopbackRefusal("Request body too large.")`; no connection is opened.
   A body of exactly `MAX_REQUEST_BODY_BYTES` is forwarded.
3. Otherwise one `fetch` to `http://127.0.0.1:<port><path>` plus `?<query>`
   when `query` is non-empty, with: the forwarded headers, `host` overwritten
   to `127.0.0.1:<port>`, `x-ttv-forwarded-request-id: <requestId>`, the body
   (or none when `body` is null/undefined), `redirect: "manual"`, the caller's
   `signal`, and a module-level undici `Agent({ headersTimeout: 0,
   bodyTimeout: 0 })` as `dispatcher` (held segment requests depend on no
   timeout).
4. A failed connection or an aborted signal rejects as `fetch` does (not a
   `LoopbackRefusal`). The returned body is not read here; a body that fails
   half-way makes the caller's `reader.read()` reject.

This file and `registry-api.js` are the only places under
`services/transport/` that call `fetch(`.

## 2. `services/transport/data-channel-handler.js` (proxy)

- Delete the local `loopbackDispatcher`, `PATH_ALLOWLIST_RE`,
  `isValidRequestPath`, `PROXY_MAX_REQUEST_BODY_BYTES` and the `undici`
  import; import `isValidRequestPath`, `MAX_REQUEST_BODY_BYTES`,
  `forwardToLoopback` and `LoopbackRefusal` from `./loopback-forward.js`.
- `startPartialRequest` and `handleBodyFrame` keep their early checks, now
  using the imported function and constant (same error strings: "Invalid
  request path.", "Request body too large.", "Request body size mismatch.").
- `forwardRequest`: keeps the early path refusal before chapter parsing, the
  `[dc]`, `[net-debug]` and `[forecast-http]` log lines unchanged in form,
  the response-start / binary chunk framing, `bodySender`, back-pressure
  (`waitForBufferDrain`) and abort handling. The `fetch` call becomes
  `forwardToLoopback({ port: proxyPort, requestId, method, path, query,
  headers: forwardedHeaders, body, signal })`. A `LoopbackRefusal` (for
  example a single-message body over the cap) is sent as
  `{ type: "response-error", requestId, error: <its message> }`; other
  rejections keep today's handling.
- A response body that errors after some bytes were sent produces one
  `response-error` frame for that request and no done frame (today's
  behaviour, pinned by a test).
- Header comment: drop "The protocol mirrors the tunnel relay protocol…"
  (the tunnel relay no longer exists).

## 3. `services/transport/tunnel-client.js` (proxy)

Delete the `"request"` message branch, `handleRelayRequest`, the
`TunnelRelayRequest` typedef, and `sendError` if nothing else uses it. An
incoming `request` frame is then ignored like any unknown type. No other
tunnel behaviour changes.

## 4. `server/services/proxy-tunnel-server.js` (server)

Delete `relay()`, its entry in the returned object's typedef (`relay`
property), `RelayPayload`, `PendingRequest`, `pendingRequests`, the
`response-start` / `response-chunk` / `response-error` handling that only
serves it, `REQUEST_TIMEOUT_MS` and the `PassThrough` import if unused after.
Keep `PendingHealthRequest`: despite its name and the issue text, it types
`pendingCanServeRequests`, which is live.

## 5. Release

- Proxy: `fix(proxy)` with `.changeset/fix-ttv-281-loopback-forward.md`:
  `- **Fix**: The proxy no longer forwards requests that arrive over the
  server tunnel; every relayed request passes one path allowlist and body cap.`
- Server: `refactor(server)` with `- **Chore**: Remove the unused tunnel request
  relay.` under `## Unreleased`.
- Order: proxy (→ add-on) first, then server.

## 6. Acceptance criteria

1. `grep -rn "fetch(" services/transport` lists only `loopback-forward.js` and
   `registry-api.js`. Checked by running the grep.
2. A `test/no-torrent/` test sends `/encode-input/1/0` and `/media?...` through
   `forwardToLoopback` and gets a `LoopbackRefusal` without a connection; a
   response body that errors half-way, forwarded by the data channel handler,
   produces a `response-error` frame and no done frame. Checked in CI.
3. `grep -rn "relay(\|handleRelayRequest" proxy/services server/services`
   returns nothing. Checked by running the grep.
4. Home Assistant field check: a film opens, seeks and switches soundtrack over
   the data channel; `[net-debug]` and `[forecast-http]` lines are unchanged in
   form.
