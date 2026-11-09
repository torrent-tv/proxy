# Design: Parse and answer byte-range requests one way

Line numbers are at proxy `origin/main` `2b58e9b4`; re-locate by name.

## 1. `utils/parse-range.js` — the one parser

```js
/** @returns {{ kind: "whole" } | { kind: "range", start: number, end: number } | { kind: "unsatisfiable" }} */
export function parseRange(header, length)
```

`length` is a non-negative safe integer (the representation's size). Rules,
RFC 9110 §14.1.2 / §14.2 for one range:

| header (length 1000) | result |
|---|---|
| absent, `""`, not a string | `whole` |
| unit other than `bytes` (unit compared case-insensitively: `Bytes=0-1` is bytes) | `whole` |
| contains `,` (multi-range) | `whole` |
| invalid syntax: `bytes=`, `bytes=-`, `bytes=abc`, `bytes=1-a`, `bytes=5-3`, digits that are not a safe integer | `whole` |
| `bytes=0-` | `range 0-999` |
| `bytes=0-0` | `range 0-0` |
| `bytes=999-` | `range 999-999` |
| `bytes=1000-`, `bytes=2000-`, `bytes=2000-3000`, `bytes=1000-1000` | `unsatisfiable` |
| `bytes=500-5000` | `range 500-999` (end clamped) |
| `bytes=-500` | `range 500-999` |
| `bytes=-1000`, `bytes=-5000` | `range 0-999` |
| `bytes=-1` | `range 999-999` |
| `bytes=-0` | `unsatisfiable` |
| length 0, any satisfiable-looking range (`bytes=0-`, `bytes=-1`) | `unsatisfiable` |
| length 0, no header | `whole` |

Optional whitespace around the value (`bytes= 0-1 `) is trimmed before
parsing; whitespace inside the range spec is invalid → `whole`.

## 2. `services/server/byte-range-reply.js` — the one way to answer

Lives in `services/server/` (the server component; biome lets it import
`../../utils/**`, though it needs nothing from there). Exports:

```js
/** Headers for a `whole` or `range` result: Content-Length, and Content-Range for a range. */
export function rangeHeaders(range, length)
// whole → { "Content-Length": String(length) }
// range → { "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${length}` }

/** 416 for an unsatisfiable range, through reply.send so hook headers stay. */
export function replyUnsatisfiable(reply, length)
// reply.code(416).header("Content-Range", `bytes */${length}`)
//      .send({ error: "The requested byte range is not satisfiable." })

/** HEAD: 200 with `headers` (which carry the true Content-Length), through reply.send. */
export function replyHead(reply, headers)
// reply.code(200).headers(headers).send(Readable.from([]))
// An EMPTY STREAM, not `send()`: the HEAD route Fastify 5 generates from a GET
// (`exposeHeadRoutes`, `fastify/lib/head-route.js`) sets `content-length: 0`
// when the payload is undefined, and leaves an explicit one alone for a
// stream payload. Checked with fastify 5.12.8 + @fastify/cors and `inject`:
// `send()` → content-length 0; `send(Readable.from([]))` → 1000, with
// access-control-allow-origin and access-control-allow-private-network.

/** The one raw head write: hijack, then writeHead from reply.getHeaders() plus `headers`. */
export function writeRawHead(reply, status, headers)
// reply.hijack(); reply.raw.writeHead(status, { ...reply.getHeaders(), ...headers });
```

`writeRawHead` exists only for the `/stream` fragment path, which writes
each fragment with `reply.raw.write(bytes, callback)` because only the callback
says when a piece may be released. Everything else answers through
`reply.send`.

## 3. Routes

Common: a route computes `range = parseRange(req.headers.range, length)`.
`unsatisfiable` → `return replyUnsatisfiable(reply, length)` before any read
is started (and after releasing anything already acquired). `whole` → status
200; `range` → 206; headers from `rangeHeaders`.

HEAD (all three routes): ignore `Range`, answer through `replyHead` with
`Accept-Ranges: bytes`, `Content-Type: application/octet-stream`,
`Content-Length: <length>` (and `Content-Disposition` on `/stream`). The
keyframe-index HEAD keeps the true length. `/media` HEAD today answers
`content-length: 0` for exactly the reason in `replyHead`; this fixes it. The
old comment in `routes/stream/get.js` that justified the hijack is replaced by
a pointer to `replyHead`.

### `/stream` (`routes/stream/get.js`)

1. Whole-file HEAD branch (`whole` and `req.method === "HEAD"`, ~line 255):
   replace `hijack` + `raw.writeHead` + `raw.end` with `replyHead`; keep the `open`/`close` check that the file exists.
2. `serveWholeFile`: use `parseRange`; `unsatisfiable` → release the read and
   `replyUnsatisfiable`; zero-length file with `whole` keeps answering 200 with
   an empty body; status and headers from `rangeHeaders`.
3. Torrent HEAD branch (~line 300): `replyHead`.
4. Fragment path: `parseRange` first; `unsatisfiable` → `replyUnsatisfiable`
   before `createFragmentReader` is called. `start`/`end` from the range
   (`whole` → `0`..`length - 1`). The head is written with
   `writeRawHead(reply, range.kind === "range" ? 206 : 200, { Accept-Ranges,
   Content-Type, Content-Disposition, ...rangeHeaders(range, file.length) })`.
   Nothing else in the fragment loop or the whole-file continuation changes.

### `/media` (`routes/media/get.js`)

Delete `mediaRange`. `unsatisfiable` → `replyUnsatisfiable` (JSON body text
changes to the shared one). `whole` (absent header, multi-range, invalid
syntax) → 200 from byte 0 to `length - 1` (invalid syntax and multi-range used
to be 416; now ignored, as RFC 9110 allows). HEAD through `replyHead` (it
answered `content-length: 0` before). The
409 `needs-ranges` path is unchanged.

### `/encode-input` (`routes/encode-input/get.js`)

1. HEAD: `replyHead` instead of hijack.
2. `unsatisfiable` → `replyUnsatisfiable` (now with the JSON body).
3. `whole` (no header, multi-range, invalid syntax) is read as from byte 0:
   `start = 0`, and the requested end is `length - 1`. A `range` gives its own
   `start`/`end`. The read is `input.read(fileIndex, start, end, true)` as now,
   and the answer stays **206** with `Content-Range: bytes <start>-<held.end>
   /<length>` and `Content-Length` of the held bytes — the route always answers
   to the end of the admitted range (`held.end`), never the whole file, so it
   cannot answer 200. (FFmpeg always sends `Range`; before this change a
   request without one got 416.) This route does not use `rangeHeaders`
   for its 206, because its end is `held.end`, not the requested end.

## 4. Release note

Proxy release notes live in `.changeset/` (`AGENTS.md`, "Repository
changesets and release path"; `CHANGELOG.md` is frozen), so the issue's
"CHANGELOG entry" is the changeset
`.changeset/fix-ttv-282-byte-range-one-way.md`:

```
- **Fix**: Byte ranges on `/stream`, `/media` and `/encode-input` are read one way (RFC 9110): `bytes=-500` is the last 500 bytes, a range past the end is answered 416 with `Content-Range: bytes */<length>` (`/stream` used to serve the whole file), and a multi-range header is answered as the whole file.
- **Fix**: HEAD answers and the `/stream` body answer keep the CORS and private-network headers.
```

## 5. Existing tests

Several existing tests drive these handlers with a hand-made `reply` that has
`hijack`/`raw.writeHead` but no `getHeaders`
(`stream-route.test.js`, `original-input*.test.js`, and others found by
`grep -ln "hijack\|writeHead\|parse-range" test/no-torrent`). The test writer
adapts those fakes in the test commit where they pin the old mechanism (e.g.
HEAD read from `raw.writeHead`), keeping every behaviour they assert. The
implementer does not edit tests.
