# Tasks: browser-fragment-processing (torrent-tv/meta#260, parent #185)

Branch `claude/project-thread-9f2a6v`. Pass/fail command: `npm test` in the
proxy (lint plus every `test/no-torrent` test, under the refuse-torrent
preload). No check here starts a real torrent: everything is exercised with
plain values (`predictPlaybackReadiness`, `browserProcessingOf`, `Viewer`) or
the existing fakes of `ViewerRequests` tests.

## Acceptance criteria

| id | criterion | check |
|---|---|---|
| AC-1 | `browserProcessingOf` (design §2): a fragment of 1500 bytes with ages loadEnd 1000, parseStart 1100, parseEnd 900, bufferingEnd 850 and one media append on the picture buffer with the same `fragmentId` and `executeMs` 50 → `{ secondsPerByte: 0.0001, fragments: 1, bytes: 1500, seconds: 0.15 }`. | unit, `test/no-torrent/browser-processing.test.js` |
| AC-2 | A muxed fragment parsed in 10 ms (parseStart after loadEnd) with appends 20 + 30 ms on `video` and 15 ms on `audio` under one `fragmentId` → work 60 ms. Two fragments of 1000 and 3000 bytes with work 10 and 50 ms → 60/4000 ms per byte (total over total, not a mean of ratios). | unit, same file |
| AC-3 | A fragment is skipped when: `bufferingEnd` is null; `loadEnd`, `parseStart` or `parseEnd` is null; no append sample has its `fragmentId`; one of its append samples has `executeMs` null or absent; `bytes` is not a positive integer. With no usable fragment, or with `null` inputs, the result is `{ reason: "browser-processing-unmeasured" }`. `init` samples never contribute. | unit, same file |
| AC-4 | Schedule (design §3.2): one track, link 8 bit/s, a ready fragment of 2 bytes (2 s transfer) and a measured rate giving 1 s of processing → the fragment's completion is 3 s (`firstRequiredStages[0].deliveryCompleteSeconds` 2, `browserProcessingSeconds` 1, `completionSeconds` 3), not 5 s and not 2 s. | unit, `test/no-torrent/playback-readiness.test.js` |
| AC-5 | Two ready fragments of one track, 1 s transfer and 0.5 s processing each → completions 1.5 s and 3 s; the readiness delay reflects the second at 3 s against the media ahead of it (a case built so the delay differs from the delay with the term absent). | unit, same file |
| AC-6 | A ready picture fragment and a ready sound fragment (separate tracks), 1 s transfer each, picture processing 0.5 s, sound unmeasured → the sound's delivery ends at 2 s, not 2.5 s. | unit, same file |
| AC-7 | With no usable sample on any track, `delaySeconds` and `reason` equal the values of the same input without `fragmentService`/`browserAppends`, and `browserProcessing` names each track with `reason: "browser-processing-unmeasured"`; the first required stage has `browserProcessingSeconds: null`, `browserProcessingReason: "browser-processing-unmeasured"`, `completionSeconds: null`. | unit, same file |
| AC-8 | Suffix (design §3.3): a film longer than the near window, one track, link and output rates chosen so that the track's own transfer of the suffix plus its processing ends later than both production and the aggregate link finish → the suffix delivery constraint uses `link.finish(bits_t) + bits_t/8 × rate`; with the rate absent the delay equals today's. | unit, same file |
| AC-9 | `Viewer` keeps `executeMs` of append samples (finite ≥ 0, or `null` when absent) and rejects a snapshot with a negative or non-finite `executeMs`, as it rejects other malformed fields. | unit, `test/no-torrent/viewer-states.test.js` |
| AC-10 | `ViewerRequests` passes the page's whole `appendService` as `browserAppends` to every track only under the existing validity condition (valid buffer capture, same `appendSessionId`), else `null`; the readiness log line contains `browserProcessing`. | unit with the existing `ViewerRequests` fakes |
| AC-11 | Existing tests that pin the old shape (`appendSeconds`, `appendReason` in `firstRequiredStages`) are updated to the new fields with their intent kept; docs and changeset of design §5 present; `npm test` exits 0 after every commit. | CI, review |
| AC-12 | Field (HA host only, skill `ha-field-check`), after proxy, add-on and server are released: open a film with a separate soundtrack and one without, wait for playback, seek forward once. Pass: the `playback readiness` log lines after the first buffered fragment show `browserProcessing` with `fragments` > 0 for every required track and a finite `secondsPerByte`; before the first fragment they show `browser-processing-unmeasured`; no new stop after start compared with the stall counters of the page log. Logs saved outside git and attached to the issue. | end to end on HA |

## Tasks

1. [ ] Test writer (fresh): test plan below (skill `writing-tests`), tests for
       AC-1…AC-10 marked `todo`, each shown failing for its AC's reason;
       commit `test(readiness): AC-1 … AC-10 browser fragment processing #ttv-260`.
2. [ ] Implementer (fresh, from the test commit): design §2–§5, removing the
       `todo` markers of the tests it makes pass; AC-11; `npm test` exits 0.
3. [ ] Reviewer approves on the current head; CI green; merge by rebase.
4. [ ] Server change `append-execute-span` merged after the add-on carrying
       this proxy; release; AC-12.

## Test plan

To be written by the test writer.
