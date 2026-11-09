# Tasks: loopback-forward (#281)

design.md is normative.

## 1. Test plan

Written by the test writer before any test (meta AGENTS.md, "Writing tests").

### 1.1 Scope and risk

Files in scope and the tests that cover them:

| File | Tests |
| --- | --- |
| `services/transport/loopback-forward.js` (new) | `test/no-torrent/loopback-forward.test.js` |
| `services/transport/data-channel-handler.js` | `test/no-torrent/data-channel-loopback.test.js` |
| `services/transport/tunnel-client.js` | `test/no-torrent/tunnel-request-ignored.test.js` |
| `services/transport/**`, `services/**` as text (AC-1, AC-3) | `test/no-torrent/loopback-forward-source.test.js` |
| shared: a local HTTP server on `127.0.0.1:0` that records connections and requests | `test/no-torrent/helpers/loopback-server.js` |

Out of scope:

- `server/services/proxy-tunnel-server.js` (design §4): another repository;
  AC-3's server half is checked by running the grep in `server`, and the
  server's own `npm test` covers what remains there.
- `registry-api.js`: unchanged; it only appears as the second allowed
  `fetch(` owner in the AC-1 source check.
- Framing (`encodeFrame`, `bodySender`), the send-queue watcher, delivery
  probes, chapter parsing, signalling: unchanged and covered by
  `data-channel-frame`, `data-channel-send-queue`, `send-chunk-bytes`,
  `tunnel-move` and `tunnel-renewal` tests.
- The `[net-debug]` / `[forecast-http]` line form: AC-4, field check.

Risk areas and depth:

1. **Loopback trust (high).** A path outside the browser route set or an
   oversized body must never reach the local server. Every case from 1.3.
2. **Truncated answers (high).** A body cut off half-way must not look
   complete to the browser. Positive and negative cases through the data
   channel handler and at the function level.
3. **Forwarding contract (medium).** URL, `host`, request id header, query,
   method, body, `redirect: "manual"`, abort. Main positive cases plus abort
   and connection failure.
4. **Tunnel relay removal (medium).** The `request` frame is ignored. One
   behaviour test plus the AC-3 source check.
5. **Zero header/body timeouts (medium).** Checked as source (see 1.3,
   uncovered behaviour).

No file in scope reaches torrent startup: `loopback-forward.js` may import
only `undici`, built-ins and `utils/`; `data-channel-handler.js` imports
`delivery-probe.js` and `undici`; `tunnel-client.js` imports `ws`.

### 1.2 Types and levels

All `node:test`, all in `test/no-torrent/`, under `refuse-torrent.cjs`:

- Unit/integration — `loopback-forward.test.js`: the real function against a
  real HTTP server on `127.0.0.1` port `0` (the only network used).
- Integration — `data-channel-loopback.test.js`: the real handler with a fake
  data channel, forwarding to the same kind of local server.
- Integration — `tunnel-request-ignored.test.js`: the real tunnel client
  against a `ws` server on port `0`, plus a local HTTP server and a recorded
  `globalThis.fetch` to observe that no forward happens.
- Static source — `loopback-forward-source.test.js`: AC-1 and AC-3 greps
  as checks on the source text (raw text, comments included, as the grep).

Run one file:
`node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/<name>.test.js`

AC levels: AC-1 static; AC-2 unit/integration; AC-3 static (proxy half) and
the tunnel behaviour test; AC-4 end-to-end on the Home Assistant host only
(open a film, seek, switch soundtrack over the data channel; `[net-debug]`
and `[forecast-http]` lines unchanged in form).

### 1.3 Case coverage

`isValidRequestPath`:
- positive: `/api/sources`, `/stream`, `/stream?x=1`, `/transcode/a/b`,
  `/health`, `/healthz`, `/health?x`;
- negative: `/encode-input/1/0`, `/media?url=x`, `/api/../encode-input/1/0`,
  `api/sources` (not absolute), `transcode/a` (not absolute), `/streamx`,
  `/healthzz`, non-string (`undefined`, `null`, `42`);
- boundary: empty string `""`, `/`.

`forwardToLoopback`:
- negative (refusal): `/encode-input/1/0` and `/media?url=…` reject with
  `LoopbackRefusal`, name `"LoopbackRefusal"`, message
  `"Invalid request path."`, an `Error`; the local server sees no
  connection.
- boundary (body cap): `MAX_REQUEST_BODY_BYTES` is 32 MiB; a body of exactly
  the cap is forwarded whole; one byte more (Buffer) is refused with
  `"Request body too large."` and no connection; a string whose character
  count is under the cap but whose UTF-8 byte length is over it is refused
  (byte length counts, not characters).
- positive: GET `/api/sources` with query `a=1&b=2` reaches
  `/api/sources?a=1&b=2`; `host` is `127.0.0.1:<port>` even when the caller
  sent another host; `x-ttv-forwarded-request-id` is the request id; other
  headers pass through; POST body reaches the server; null body sends none.
- boundary: empty query adds no `?`; a 302 answer is returned as 302 with its
  `location`, not followed; the returned body is unread (the caller reads it).
- negative: an already aborted signal and an abort while the server holds
  the request reject, and not with `LoopbackRefusal`; a closed port rejects,
  not with `LoopbackRefusal`; a body cut off half-way makes the caller's
  `reader.read()` reject after the bytes sent.

Data channel handler (`request` message):
- negative: `/encode-input/1/0` and `/media?…` → one `response-error`
  `"Invalid request path."`, no connection to the local server;
- boundary: a single-message body one byte over the cap → `response-error`
  `"Request body too large."`, no connection;
- negative: a response body that fails after some bytes → body frames for
  those bytes, then one `response-error` for the request and no done frame;
- positive: an allowed route is forwarded with `host` and
  `x-ttv-forwarded-request-id`, answered by `response-start` and a done frame.

Tunnel client:
- negative: an incoming `request` frame for `/encode-input/1/0` produces no
  forward (no `fetch`, no connection to the local server) and no
  `response-*` reply; the connection keeps answering (`rtt-probe` →
  `rtt-echo` after it).

Source (AC-1, AC-3):
- `fetch(` appears under `services/transport/` only in `loopback-forward.js`
  and `registry-api.js`;
- `relay(` and `handleRelayRequest` appear nowhere under `services/`;
- the loopback forwarder builds its undici `Agent` with `headersTimeout: 0`
  and `bodyTimeout: 0`.

Deliberately not covered:
- The zero timeouts as behaviour: proving them needs a request held past
  undici's 300 s default, i.e. real time; covered as source instead.
- A body exactly at the cap through the data channel: the cap is owned by
  `forwardToLoopback` and its boundary is tested there; a 32 MiB JSON
  round-trip twice per run adds time and no new case.
- Chunked (`request-start`) bodies: their checks are unchanged in behaviour
  and string (design §2).
- Server-side deletion of `relay()`: other repository (see 1.1).
- `[net-debug]` / `[forecast-http]` form: AC-4 field check.

### 1.4 Rules and exit

- Expected failure before the code exists:
  - `loopback-forward.test.js`: `ERR_MODULE_NOT_FOUND` for
    `services/transport/loopback-forward.js` (the module is the subject).
  - `data-channel-loopback.test.js`: the oversized single-message body is
    forwarded (`response-start`, a connection) instead of refused; the other
    cases pass today and pin behaviour the refactor must keep.
  - `tunnel-request-ignored.test.js`: the tunnel calls `fetch` for the
    `request` frame and replies.
  - `loopback-forward-source.test.js`: `fetch(` found in
    `data-channel-handler.js` and `tunnel-client.js`; `handleRelayRequest`
    found in `tunnel-client.js`; `loopback-forward.js` missing.
- Deterministic: no sleeps or fixed waits; waits are `until` on an observed
  event or `settle`; network only on `127.0.0.1` port `0`; no shared state
  between tests; no files written.
- One behaviour per test, named as a sentence.
- Exit: `npm test` exits 0.

## 2. Tests (test writer, separate commit)

- [x] 2.1 Failing tests for AC-1..AC-3 under `test/no-torrent/`, committed
      alone as `test(proxy): …`.

## 3. Implementation (implementer, from the test commit)

- [x] 3.1 `services/transport/loopback-forward.js` (design §1).
- [x] 3.2 `data-channel-handler.js` uses it (design §2).
- [x] 3.3 Delete the tunnel relay in `tunnel-client.js` (design §3).
- [x] 3.4 Changeset (design §5). `npm test` exits 0.
- [x] 3.5 Server: delete `relay()` and its dead state (design §4), changelog
      entry; `npm test` exits 0 in server.

## 4. Release and field check

- [x] 4.1 Proxy released and installed in the add-on, then server released.
- [x] 4.2 AC-4 on the Home Assistant host.
