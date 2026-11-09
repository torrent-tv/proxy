# Tasks: seek-run-range (torrent-tv/meta#341)

Branch `fix/ttv-341-seek-run-range`. Pass/fail command: `npm test` in the
proxy (lint plus every `test/no-torrent` test). No check on this Mac starts a
real torrent: `EncodeInputs`, `EncodeRuns` and `SegmentServing` are exercised
with fakes for resolution, held ranges, the whole-file opener, ffmpeg spawn and
the segment store.

## Acceptance criteria

| id | criterion | check |
|---|---|---|
| AC-1 | `EncodeInputs.take(output, from, to, serves)` never returns a stretch with `to < serves`. A held stretch that ends below a new `serves` is released, the request is prepared again with that `serves` (without waiting for new bytes), and the line `encode input #F..#T of <addr>: the held stretch #F..#E does not reach #S, the piece it is now taken for; prepared again` is logged once; when that preparation is ready, `take` returns a stretch with `from = F` and `to >= S`. A stretch that already reaches `serves` is returned as before. | unit, `test/no-torrent/encode-inputs.test.js` (fake `resolve`, `heldRanges`, `readRanges`, logger) |
| AC-2 | `#admitStretch` never answers a stretch ending below `serves`: when the stretch through `serves` does not resolve, the request's answer is that resolution's answer (`needs-bytes` with its awaited ranges, so `bytesChanged` naming them prepares it again), not `#from..#from`. | unit, `test/no-torrent/original-input-stretch.test.js` or `encode-inputs.test.js` |
| AC-3 | No run is built with `to < from`. Field case: the piece before #188 is being made, the input keyed at #187 holds #187..#187; the plan starts #188 → `makeRunAt` returns null and no ffmpeg is spawned; after an input reaching #188 is ready, the run is built with `from` 188 and `to >= 188`. | integration: real `EncodeRuns` + `EncodeInputs`, fake spawn and resolution (as in `input-copy-while-open.test.js`) |
| AC-4 | With an encode-input owner present, a last run ending `ENDED_FAILED` with no `EncodeInputs.failureOf` and no `InputFailures.reason` leaves `runStateOf` = `IDLE` and `hasFailed` false; held requests are not invalidated as failed; a request for a missing segment is held, not answered 500, and is answered 200 when a later run publishes the segment. | integration: `EncodeRuns` + `SegmentServing` + `waitForRequestedFile`, fake run ending (`EXITED_SHORT`, 0 segments) and a later publication |
| AC-5 | A terminal input fact still ends production: with `InputFailures.reason` set (a single-piece input failed) or `EncodeInputs.failureOf` terminal, and no live run, `runStateOf` = `ENDED_FAILED` and a missing segment is answered 500 `canRetry: false`. Existing tests `input-failures.test.js`, `failed-encoder-still-serves-what-exists.test.js`, `failed-start-breaker.test.js` stay green. | regression test + existing tests |
| AC-6 | On an ending of AC-4, `noteRunEnded` logs once `encode: run #A..#B of <addr> ended ENDED_FAILED (<because>); production goes on — no input failure ends it, so requests for its pieces stay held`; on an ending of AC-5 it does not. | unit with a recording logger |
| AC-7 | Field (HA host only, skill `ha-field-check`): after release and add-on update, open Below S01E01 1080p MKV, seek five times including to 1927 s, play 30 s after each seek. Copy the proxy and page logs to meta `research/session-logs-<date>-ttv341/` and commit them. Pass: every seek resumes playback with no error screen; the inverted-run count below, over the log slice from the process start, prints 0; no `/transcode/…/segment-… → 500` without a terminal input line for that output before it. | end-to-end on HA |
| AC-8 | `npm test` exits 0 after every commit; `docs/encode-run-state.md` states the run/output distinction (design §3.5); the changeset of design §3.6 is present. | CI, review |

The inverted-run count of AC-7 (prints 52 on meta
`research/session-logs-2026-11-09-ttv289/proxy-tail.log.gz`, the log before the
fix):

```sh
gzcat proxy.log.gz | grep -aoE 'encode-run #[0-9]+\.\.#[0-9]+ of [^ ]+ by' \
  | awk '{split($2,a,/\.\.#|#/); if (a[3]+0 < a[2]+0) n++} END {print n+0}'
```

## Tasks

1. [ ] Test writer (fresh): write the test plan into this file under
       "Test plan" (skill `writing-tests`), write the tests for AC-1…AC-6
       marked `todo`, show each fails for its AC's reason, commit
       `test(proxy): AC-1 … AC-6 … #ttv-341`.
2. [ ] Implementer (fresh, worktree from the test commit): design §3.1–3.6 in
       that order, removing the `todo` markers of the tests it makes pass.
       `npm test` exits 0.
3. [ ] Reviewer approves on the current head; CI green; merge by rebase.
4. [ ] Release; HA add-on update; AC-7.

## Test plan

Written by the test writer (skill `writing-tests`).

### 1. Scope and risk

Files in scope and the tests covering each:

| file | tests |
|---|---|
| `services/encode/EncodeInputs.js` (`take`, `#admitStretch`) | `test/no-torrent/encode-inputs.test.js` (AC-1, AC-2); `test/no-torrent/run-starts-inside-its-input.test.js` (AC-3) |
| `services/encode/EncodeRuns.js` (`runStateOf`, `noteRunEnded`) | `test/no-torrent/run-starts-inside-its-input.test.js` (AC-3); `test/no-torrent/failed-run-production-goes-on.test.js` (AC-4, AC-5, AC-6) |
| `services/server/SegmentServing.js`, `services/server/transcode-session-files.js` (unchanged; read through) | `test/no-torrent/failed-run-production-goes-on.test.js` (AC-4, AC-5) |
| `docs/encode-run-state.md`, `.changeset/fix-ttv-341-seek-run-range.md` | review (AC-8); no test |

Out of scope: `EncodeRun.js` and `encode-run-state.js` (the per-run machine
does not change; covered by their own tests); `EncodeOrchestrator.stateOf`
and the `no encoder could be made` line (proposal: out of scope);
`OriginalInput.js` (the copy itself does not change); outputs without an
encode-input owner (tests only; the existing `retrying` rule is kept).

Depth per risk area:

1. Waiting model (a stretch handed out, prepared again, woken by bytes): high.
   Every case of part 3 for `take` and `#admitStretch`.
2. State machine of an output (`runStateOf`, `hasFailed`, held requests): high.
   The non-terminal ending (request held before and after it), both terminal
   facts, and the log line in both directions.
3. HLS delivery (500 vs hold vs 200): high, through `serveSessionFile` and
   `waitForRequestedFile` on a real manager.
4. Torrent startup: not reached. Every boundary is a fake: resolution, held
   ranges, reads and the whole-file opener in `EncodeInputs`; the encode-input
   owner (`fakeEncodeInputs`) for AC-4..AC-6; ffmpeg as `fakeProcess`, and
   `ffmpegBin` `/nonexistent/ttv-341/no-encoder` where `EncodeRuns` builds a
   run itself (its `spawn` is not injectable), so no program is started.
   `scripts/check-tests-start-no-torrent.mjs` passes on the new files.

### 2. Types, levels and commands

All `node:test`, under `refuse-torrent.cjs`:

```sh
node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/<name>.test.js
```

| AC | level | file |
|---|---|---|
| AC-1 | unit: real `EncodeInputs`, fake resolution, held ranges, reads, logger | `encode-inputs.test.js` |
| AC-2 | unit: same | `encode-inputs.test.js` |
| AC-3 | integration: `wireOutputs` with real `EncodeRuns` + real `EncodeInputs`, fake resolution, a fake process for the run making #187, recording logger | `run-starts-inside-its-input.test.js` |
| AC-4 | integration: `wireOutputs` (`EncodeRuns` + `SegmentServing` + `waitForRequestedFile`/`serveSessionFile`), `fakeEncodeInputs`, a fake process ending `0` with no segment, publication by writing the served file | `failed-run-production-goes-on.test.js` |
| AC-5 | integration (regression): same, with `InputFailures` recording a single-piece input (`run.admittedInputKeys`, exit 1) or `failureOf` answering terminal | `failed-run-production-goes-on.test.js`; existing `input-failures.test.js`, `failed-start-breaker.test.js`, `failed-encoder-still-serves-what-exists.test.js` |
| AC-6 | integration with a recording logger (`mock.method(logger, …)`) | `failed-run-production-goes-on.test.js` |
| AC-7 | end-to-end on HA, skill `ha-field-check`; steps and pass in the AC table | — |
| AC-8 | `npm test`, review | — |

### 3. Case coverage

`EncodeInputs.take` (AC-1), field numbers (input keyed at #187, ready
#187..#187 for `serves` 187):

1. Positive: taken for `serves` 188 it is not handed out (returns null).
2. Positive: the held stretch is released (its `release` called once).
3. Positive: with no new bytes and no memory change, a later `take` for 188
   returns a stretch from #187 reaching at least #188.
4. Positive: the line `… the held stretch #187..#187 does not reach #188, the
   piece it is now taken for; prepared again` is said once for two takes.
5. Boundary, current behaviour (not `todo`, passes before the change): a held
   stretch ending exactly at `serves` (#187..#188 for 188) is the object handed
   out, with no further resolution.

`EncodeInputs.#admitStretch` (AC-2), resolution of #187..#188 answering
`needs-bytes` naming bytes 1880..1889:

1. Positive: no `result` ending below #188 is announced.
2. Positive: the request says `needs-bytes` once.
3. Positive: an event naming bytes 1880..1889 prepares it, and `take` returns
   #187..#≥188.
4. Negative: a resolution of #187..#188 answering `terminal` is the request's
   answer (`failureOf(output).reason`).

`EncodeRuns.makeRunAt` (AC-3), field case on a real manager:

1. Negative: the plan asks for #188 → null, and no `encode-run #…` line (no
   run, no encoder).
2. Positive: asked again after the preparation → a run with `from` 188 and
   `to >= 188`.

`EncodeRuns.runStateOf` / `SegmentServing` (AC-4), the only run #3..#4 exits
0 with no segment, no input failure, no terminal input:

1. `runStateOf` is `IDLE`.
2. `hasFailed` is false.
3. A request held before the ending is answered `file` once segment 3 is
   published (a failure at the ending would have been its answer).
4. A request after the ending is held and answered 200 once segment 3 is
   published.

Terminal facts (AC-5, regression, not `todo`):

1. `InputFailures.reason` (run holding #3 alone, exit 1): `ENDED_FAILED`, 500
   `canRetry: false`.
2. `EncodeInputs.failureOf` terminal: `ENDED_FAILED`, 500 `canRetry: false`.

The line (AC-6):

1. Positive: the ending of AC-4 says `encode: run #3..#4 of <key> ended
   ENDED_FAILED (…); production goes on — no input failure ends it, so requests
   for its pieces stay held` exactly once.
2. Negative (not `todo`): not said for either ending of AC-5; the first
   asserts that the input failure was recorded, so the absence is not vacuous.

Not covered, with reasons:

1. Bytes not named by a waiting `needs-bytes` do not wake it: covered by the
   existing `original-input-stretch.test.js` ("an input waiting for its bytes
   is tried again when some of them arrive…").
2. A resolution of the stretch through `serves` that throws: the specification
   names no answer for it.
3. Several viewers and several outputs: not part of either root cause.
4. A position failing again and again without an input failure (design risk
   1): named, not handled by this change.

### 4. Rules and exit

1. Each new `todo` test fails before the code exists, run with the command of
   part 2. Expected failures at `5ef2697c`:
   - AC-1: `take` returns the #187..#187 object; `released` 0; no stretch
     reaching #188 ready; the line said 0 times.
   - AC-2: `['#187..#187']` announced; no `needs-bytes` line; ready stretch is
     #187..#187; `failureOf` undefined.
   - AC-3: `a run was built: '#188..#187'`; then no run built.
   - AC-4: `ENDED_FAILED` not `IDLE`; `hasFailed` true; the held request
     answered `failed: it exited cleanly at #2 of #4 — its input stopped`; the
     later request answered 500 `canRetry: false`.
   - AC-6: the line said 0 times.
2. No real timers: waits are on events (`setImmediate` turns, the store's
   registered wait, the publication); `timeout: 10_000` is only a backstop.
3. Exit: `npm test` (biome lint, then every `test/no-torrent` test).
