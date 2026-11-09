# Proposal: Parse and answer byte-range requests one way

Issue: torrent-tv/meta#282 (sub-issue 16.02 of torrent-tv/meta#279, change
`one-way-per-task`).

## Why

Byte ranges in the proxy's HTTP routes are parsed by two functions with
different results and answered three ways.

1. `utils/parse-range.js` `parseRange` reads `bytes=-500` as bytes 0-500
   (RFC 9110 §14.1.2: the LAST 500 bytes), turns `bytes=2000-3000` on a
   1000-byte file into `{ start: 2000, end: 999 }`, and refuses `bytes=2000-`
   past the end only by accident (`end < start`).
2. `routes/media/get.js` has its own `mediaRange`, which parses the suffix form
   correctly.
3. With an unsatisfiable range `/encode-input` answers 416 with no body,
   `/media` answers 416 with JSON, and `/stream` never answers 416: a `null`
   range serves the whole file with 200, and `{ start: 2000, end: 999 }`
   yields a negative `Content-Length`.
4. HEAD answers on `/stream` and `/encode-input`, and the `/stream` body
   answer from the torrent's fragments, use `reply.hijack()` +
   `reply.raw.writeHead(...)`. That drops every header set by hooks
   (`@fastify/cors`, `Access-Control-Allow-Private-Network` in `server.js`),
   so these answers carry no CORS headers on a direct HTTP transport.

For the viewer: a browser (or an `<video>` element) reading `/stream` directly
over HTTP from another origin gets answers without
`access-control-allow-origin`, which the browser refuses; a suffix range
returns the wrong bytes; an out-of-range read returns the whole file instead of
an error. For us: one parser and one way to answer means one place to fix.

## What changes

- `utils/parse-range.js` is rewritten: `parseRange(header, length)` returns
  `{ kind: "whole" } | { kind: "range", start, end } | { kind: "unsatisfiable" }`
  following RFC 9110 for a single range.
- `mediaRange` in `routes/media/get.js` is deleted; `/stream`, `/media` and
  `/encode-input` all call `parseRange`.
- New `services/server/byte-range-reply.js` holds the shared answers:
  `rangeHeaders`, `replyUnsatisfiable`, `replyHead`, and `writeRawHead` (the one raw head
  write, for the `/stream` fragment path that needs write callbacks; it starts
  from `reply.getHeaders()` so hook headers survive).
- HEAD answers go through `reply.send` (`replyHead`) with explicit headers, and keep the true `Content-Length` (`/media` HEAD answered `content-length: 0`); no route calls
  `reply.raw.writeHead` or `reply.hijack()` directly.
- `/stream` answers 416 where it used to serve the whole file.

## Out of scope

- The whole-file continuation logic in `/stream` (`acquireWholeFileRead`,
  `writeFromWholeFile`, continuing a torrent read from the downloaded file):
  unchanged except that its head is written through `writeRawHead`.
- Request-field parsing (`sourceKey`, `fileIndex`, `token`, query fields):
  a separate sub-issue of #279.
- Multi-range answers (`multipart/byteranges`): not supported; a multi-range
  header is answered as if absent.
- `If-Range`, `ETag`, conditional requests: not supported, unchanged.
- `server.js`: unchanged; the routes keep their wiring.
