# Tasks and test plan: byte-range-one-way (torrent-tv/meta#282)

## Tasks

1. [ ] Test writer: write the tests below, adapt existing fakes (design §5),
       confirm every new test fails for the stated reason, commit
       `test(proxy): AC-1 … #ttv-282` on `fix/ttv-282-byte-range-one-way`.
2. [ ] Implementer (fresh, from the test commit): `utils/parse-range.js`,
       `services/server/byte-range-reply.js`, `routes/stream/get.js`,
       `routes/media/get.js`, `routes/encode-input/get.js`, the changeset
       (design §4). `npm test` exits 0.
3. [ ] Reviewer approves on the current head; CI green; merge by rebase.
4. [ ] Release; Home Assistant field check (part 2.3 below).

## Test plan

### 1. Scope and risk

Files in scope and the tests that cover each:

| file | tests |
|---|---|
| `utils/parse-range.js` | `test/no-torrent/parse-range.test.js` (unit, new) |
| `services/server/byte-range-reply.js` | covered through the routes in `byte-range-routes.test.js` (integration, new); no separate unit file |
| `routes/stream/get.js`, `routes/media/get.js`, `routes/encode-input/get.js` | `test/no-torrent/byte-range-routes.test.js` (integration, new); existing route tests stay green |

Out of scope: `server.js` (not imported: `scripts/check-tests-start-no-torrent.mjs`
refuses it; the test registers the handlers itself, with `@fastify/cors`
`{ origin: true }` and the same `onRequest` private-network hook as
`server.js:~167`); the whole-file continuation in `/stream` (unchanged; its
existing tests cover it); request-field parsing (another sub-issue).

Risk areas and depth:

- Range parsing — high: every case in part 3.
- ffmpeg input (`/encode-input` answering to `held.end`, `/stream` fragment
  path) — high: the 206 shape for every header form, the 416 path reads
  nothing, and the field check.
- CORS/hook headers — medium: asserted on every answer of the route matrix.
- HEAD length (keyframe index) — high: true `Content-Length` on every route
  and both `/stream` paths.
- Torrent startup — none: no real torrent anywhere; the torrent pool, the
  fragment reader and the original input are fakes.

### 2. Levels and commands

1. Unit — `parseRange`:
   `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/parse-range.test.js`
2. Integration — real Fastify 5 + `@fastify/cors` + the hook, the three real
   handlers, fakes only for `torrentPool` / `sourceRegistry` / `inputOf`,
   requests through `app.inject()` with an `Origin` header:
   `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/byte-range-routes.test.js`
   `/stream` is exercised on both paths: the torrent fragment path (a fake
   file with `createFragmentReader`) and the downloaded-file path (a fake
   `wholeFiles` entry over a real 1000-byte temp file and `acquireWholeFile`).
3. End-to-end — Home Assistant host only, after release (AC-4): an AVI and an
   MKV from `/Users/silentimp/Library/CloudStorage/Dropbox/trn` opened on the
   HA proxy through the page per `docs/ha-browser-mcp-testing.md`, each
   started and seeked once mid-film. Pass: both play after start and after the
   seek; the downloaded proxy log for the run has no `416` answer to
   `/stream` or `/encode-input`, no "outside the admitted ranges" and no
   "Source response is incomplete". Tab closed and host cleaned after.

AC → level: AC-1 integration (+ unit for the parser); AC-2 the `grep`
(`grep -n "mediaRange\|raw.writeHead" routes` prints nothing — the only raw
write is in `services/server/byte-range-reply.js`); AC-3 CI + changeset;
AC-4 end-to-end.

### 3. Cases

#### `parseRange` (length 1000 unless stated)

Positive: `bytes=0-` → range 0-999; `bytes=0-499` → 0-499; `bytes=-500` →
500-999; `bytes=500-5000` → 500-999; `Bytes=0-1` → 0-1; `bytes= 0-1 ` → 0-1.

Negative (→ `whole`): absent (`undefined`), `""`, a value that is not a
string (`["bytes=0-1"]`), `items=0-1`,
`bytes=0-1,5-6`, `bytes=`, `bytes=-`, `bytes=abc`, `bytes=1-a`, `bytes=5-3`,
`bytes=0 - 1`, `bytes=99999999999999999999-`.

Negative (→ `unsatisfiable`): `bytes=2000-`, `bytes=2000-3000`, `bytes=-0`.

Boundaries: `bytes=0-0` → 0-0; `bytes=999-` → 999-999; `bytes=999-999` →
999-999; `bytes=1000-` → unsatisfiable; `bytes=1000-1000` → unsatisfiable;
`bytes=-1` → 999-999; `bytes=-1000` → 0-999; `bytes=-1001` → 0-999;
length 1: `bytes=0-` → 0-0, `bytes=1-` → unsatisfiable; length 0: no header
→ whole, `bytes=0-` → unsatisfiable, `bytes=-1` → unsatisfiable.

#### Routes (file length 1000; every answer also asserts
`access-control-allow-origin` = the request's `Origin` and
`access-control-allow-private-network: true`)

| header | `/stream` (both paths) | `/media` | `/encode-input` (admitted range ends at `held.end`) |
|---|---|---|---|
| none | 200, CL 1000, no CR | 200, CL 1000, no CR | 206, CR `0-<held.end>/1000` |
| `bytes=0-` | 206, CR `0-999/1000`, CL 1000 | same | 206, CR `0-<held.end>/1000` |
| `bytes=-500` | 206, CR `500-999/1000`, CL 500 | same | 206, CR `500-<held.end>/1000` |
| `bytes=2000-` | 416, CR `*/1000`, nothing read | same | 416, CR `*/1000`, `input.read` not called |
| `bytes=2000-3000` | 416, CR `*/1000` | same | 416, CR `*/1000` |
| `bytes=0-1,5-6` | 200, CL 1000, no CR | same | 206 from byte 0 |
| HEAD | 200, CL 1000, no body | 200, CL 1000 | 200, CL 1000 |
| HEAD + `bytes=0-1` | 200, CL 1000 (Range ignored) | — | — |
| HEAD + `bytes=2000-` | 200, CL 1000 (Range ignored, no 416) | 200, CL 1000 (Range ignored, no 416) | 200, CL 1000 (Range ignored, no 416) |

`/stream` body bytes equal the expected slice of the fake file on both paths.
`/media` reads served from a fake `readHeldOf` that holds every byte.
`/encode-input` requests come from `127.0.0.1` (`inject` sets
`remoteAddress: "127.0.0.1"` by default).

Not covered, with reason: the 409 `needs-ranges` and 503 paths (unchanged,
existing tests cover them); zero-length file on `/media` and `/encode-input`
(both refuse a length ≤ 0 with 404 before parsing, unchanged).

### 4. Rules and exit

1. Before the code: `parse-range.test.js` fails on the shape (the old
   function returns `{start,end}`/`null`, not `{kind}`) and on the suffix /
   past-the-end cases; `byte-range-routes.test.js` fails on: `/stream` 416
   rows (old: 200 / negative length), CORS headers on HEAD and the `/stream`
   fragment body (old: missing), `/stream` and `/encode-input` `bytes=-500`
   (old: bytes 0-500), `/media` HEAD length (old: 0) and multi-range row
   (old: 416), `/encode-input` no-header and multi-range rows (old: 416) and
   its 416 rows (old: no JSON body). The rows whose answer the change keeps
   pass before the code and stay as regression guards: `/stream` from a
   downloaded file with no header, `bytes=0-` and multi-range (that path
   already answers through `reply.send`); `/media` with no header, `bytes=0-`,
   `bytes=-500`, `bytes=2000-` and `bytes=2000-3000`; `/encode-input`
   `bytes=0-`. Existing tests adapted (design §5): `stream-route.test.js`
   (the reply fake gains `headers`/`getHeader(s)`/`hasHeader`; "no body" on
   HEAD also accepts an empty stream) and `downloaded-media-route.test.js`
   (the same fake methods; malformed and multi-range headers are now answered
   as the whole file, a new failing case, instead of 416). The test commit
   message names AC-1.
2. Deterministic: no timers, no network beyond `inject`, temp files in the
   test's own `fs.mkdtemp` directory, removed after.
3. One behaviour per test; names state it.
4. Exit: `npm test` in the proxy exits 0.
