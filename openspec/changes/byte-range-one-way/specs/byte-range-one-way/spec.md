# byte-range-one-way — delta spec (proxy)

## ADDED Requirements

### Requirement: One byte-range parser

The proxy SHALL parse the `Range` header of `/stream`, `/media` and
`/encode-input` with one function, `parseRange(header, length)` in
`utils/parse-range.js`, which returns exactly one of
`{ kind: "whole" }`, `{ kind: "range", start, end }` (inclusive, `0 <= start
<= end <= length - 1`) or `{ kind: "unsatisfiable" }`.

#### Scenario: Suffix range
- **WHEN** the header is `bytes=-500` and the length is 1000
- **THEN** the result is `{ kind: "range", start: 500, end: 999 }`

#### Scenario: Range past the end
- **WHEN** the header is `bytes=2000-` or `bytes=2000-3000` and the length is 1000
- **THEN** the result is `{ kind: "unsatisfiable" }`

#### Scenario: No header, multi-range, unknown unit or invalid syntax
- **WHEN** the header is absent, empty, `bytes=0-1,5-6`, `items=0-1`, or
  syntactically invalid (`bytes=5-3`, `bytes=abc`, `bytes=-`)
- **THEN** the result is `{ kind: "whole" }`

### Requirement: One way to answer a range

A `whole` result SHALL be answered 200 with `Content-Length` equal to the
length and no `Content-Range`; a `range` result 206 with
`Content-Range: bytes <start>-<end>/<length>` and
`Content-Length: <end - start + 1>`; an `unsatisfiable` result 416 with
`Content-Range: bytes */<length>` and a JSON body. Every one of these answers,
and every HEAD answer, SHALL carry the headers set by `onRequest` hooks
(`access-control-allow-origin`, `access-control-allow-private-network`).

#### Scenario: /stream with a range past the end
- **WHEN** `/stream` is asked for `bytes=2000-` of a 1000-byte file
- **THEN** it answers 416 with `Content-Range: bytes */1000` and reads nothing

#### Scenario: HEAD keeps the true length
- **WHEN** `/stream` or `/encode-input` is asked with HEAD
- **THEN** it answers 200 with `Content-Length` equal to the file length and
  with the hook headers

#### Scenario: /encode-input keeps answering to the end of the admitted range
- **WHEN** `/encode-input` is asked for `bytes=<s>-` (or any satisfiable range,
  or no range) and the admitted range that holds `<s>` ends at `held.end`
- **THEN** it answers 206 with `Content-Range: bytes <s>-<held.end>/<length>`
