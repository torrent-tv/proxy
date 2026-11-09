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
