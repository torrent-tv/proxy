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

### 1. Scope and risk

1. Files in scope and the tests covering each:
   1. `services/viewer/browser-processing.js` (new, `browserProcessingOf`):
      `test/no-torrent/browser-processing.test.js` (AC-1, AC-2, AC-3).
   2. `services/viewer/playback-readiness.js` (`predictPlaybackReadiness`,
      `scheduleTransfers`, `scheduleTail`, `firstRequiredStages`, the result's
      `browserProcessing`): `test/no-torrent/playback-readiness.test.js`
      (AC-4 to AC-8).
   3. `services/viewer/Viewer.js` (`appendServiceSnapshot`):
      `test/no-torrent/viewer-states.test.js` (AC-9).
   4. `services/server/ViewerRequests.js` (`#playbackReadinessFor`: the
      `browserAppends` input and the `playback readiness` log line):
      `test/no-torrent/readiness-browser-processing.test.js` (AC-10).
2. Out of scope:
   1. `test/no-torrent/support/whole-film-forecast.js`, the reference model:
      design §3.1 keeps its own `appendSeconds`, which reads 0 because no test
      sets it; no test file imports the module today (`grep -rn whole-film
      test/` finds only its own file and a test name).
   2. `browserServiceSummary` and `browserServiceFingerprint` in
      `ViewerRequests.js`: unchanged by the design (the log keeps its sample
      summary; `browserProcessing` is logged as part of the forecast).
   3. Docs and changeset (design §5): AC-11, reviewed, not tested.
   4. The server's `executeMs` field: server change `append-execute-span`,
      its own test plan.
3. Risk areas and depth:
   1. The waiting model (`predictPlaybackReadiness`; high: the start gate
      opens on it). Every case of part 3: the near window (AC-4, AC-5, AC-6),
      the unmeasured fallback (AC-7) and the suffix bound (AC-8).
   2. The measurement of one fragment's processing (high: every charged second
      comes from it). Every case of part 3 (AC-1 to AC-3).
   3. Report validation in `Viewer` (medium: untrusted page input). Positive,
      negative and boundary values of `executeMs` (AC-9).
   4. Wiring and log in `ViewerRequests` (low: one input and one log field).
      The main positive case, the two gates that refuse the samples, and the
      log line (AC-10).
   5. Torrent startup: not touched. Every test is plain values or the existing
      `managerWithOwnStore` wiring with `getSourceStats` given; no test reaches
      `TorrentPool`, WebTorrent or the worker
      (`node scripts/check-tests-start-no-torrent.mjs` passes on these files).

### 2. Types and levels

All `node:test`, run under the refuse-torrent preload. End to end is AC-12 on
the Home Assistant host (skill `ha-field-check`), not part of this plan.

| AC | level | command | tests |
|---|---|---|---|
| AC-1 | unit | `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/browser-processing.test.js` | "a parse that started during the load is clipped to the end of the load"; "a parse that ended before the load ended charges no parse time"; "a fragment buffered at the snapshot with zero parse and execute spans is a measurement of zero work" |
| AC-2 | unit | same | "a muxed fragment's appends to separate buffers count as parallel: the larger buffer sum"; "a fragment whose only appends went to the other buffer is measured by them"; "a track's rate is its total work over its total bytes, not a mean of per-fragment rates" |
| AC-3 | unit | same | "a fragment not yet buffered is skipped"; "a fragment without its load end or parse marks is skipped"; "a fragment with no append sample of its identity is skipped"; "a fragment with one append lacking a usable execute span is skipped whole, not counted in part"; "a fragment whose bytes are not a positive integer is skipped"; "a fragment without an identity is skipped"; "with no usable fragment the track is unmeasured"; "absent inputs leave the track unmeasured"; "init samples never contribute" |
| AC-4 | unit | `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/playback-readiness.test.js` | "a fragment is in the page at its delivery plus its processing, each counted once"; "the start waits for the processing of the first fragment" |
| AC-5 | unit | same | "a track's next fragment is requested only after the previous one is processed"; "the start delay counts each fragment's processing before the next request" |
| AC-6 | unit | same | "the other track uses the link while a fragment is processed" |
| AC-7 | unit | same | "without a usable sample the forecast charges nothing and names each track unmeasured"; "before the page has buffered a fragment every track is named unmeasured"; "an unmeasured first required fragment states no processing and no completion"; "a measured track names its rate and sample count in the result" (design §3.5, the measured form of the same field) |
| AC-8 | unit | same | "the suffix finishes a measured track no earlier than its own transfer plus its processing" |
| AC-9 | unit | `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/viewer-states.test.js` | "an append sample keeps the execute span the page measured"; "an append sample from a page that measures no execute span keeps it as null"; "a negative or non-finite execute span makes the append report invalid" |
| AC-10 | integration (real `wireOutputs` with `ViewerRequests`, `Viewer` reading and source stats given) | `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/readiness-browser-processing.test.js` | "the page's whole append report measures the processing of the track it watches"; "samples the page measured for another output measure nothing"; "samples of a report whose buffer capture is not valid measure nothing"; "the readiness log line states each track's processing rate and sample count" |
| AC-11 | CI, review | `npm test` | none new; see "Existing tests that pin the old shape" |
| AC-12 | end to end, HA host | skill `ha-field-check` | none here |

### 3. Case coverage

1. `browserProcessingOf`:
   1. Positive: the AC-1 fragment (parse clipped to 100 ms, 50 ms append,
      1500 bytes) gives `{ secondsPerByte: 0.0001, fragments: 1, bytes: 1500,
      seconds: 0.15 }`; a muxed fragment takes the larger buffer sum
      (10 + max(50, 15) ms); a fragment whose appends are all on the other
      buffer is measured by them; two fragments give total work over total
      bytes (60 ms / 4000 bytes, not the mean of 1/100 and 1/60).
   2. Negative: `bufferingEnd`, `loadEnd`, `parseStart` or `parseEnd` null;
      no append with the fragment's identity; one of its appends with
      `executeMs` null, absent, -1 or `NaN` (the fragment is skipped whole,
      the other buffer's 500 ms is not counted); `bytes` 0, negative,
      fractional, `NaN`, a string or null; `fragmentId` empty or null; `null`
      inputs. Each skipped fragment sits beside one usable fragment, so the
      result shows it skipped and the usable one still measured.
   3. Boundary: every age 0 and `executeMs` 0 (buffered at the snapshot
      moment) is a measurement of zero work; a parse wholly before the load
      end charges 0 parse; no sample at all and no usable sample give
      `browser-processing-unmeasured`; `init` fragment samples and `init`
      append samples under a media fragment's identity add nothing.
2. Schedule (`predictPlaybackReadiness`), link 8 bit/s so one byte is one
   second of transfer, rates measured from the page's samples:
   1. Positive: transfer 2 s plus processing 1 s is in the page at 3 s, not
      5 s and not 2 s, and the start waits 3 s (AC-4); two fragments of one
      track at 1 s + 0.5 s each complete at 1.5 s and 3 s, the second holds
      the start (`holdingBy` at 3 s against 1 s of film) and the delay is 2 s
      against 1 s without the term (AC-5); the sound fragment is delivered at
      2 s while the picture is processed until 1.5 s (AC-6); the suffix of a
      film whose first 4 s the page holds is in the page at 8 s of transfer
      plus 16 s of processing, in the page at 24 s against 12 s of film: a
      delay of 12 s (AC-8); a measured track is named with its rate and sample count.
   2. Negative: unusable samples (fragment not buffered) give the same delay
      and reason as no samples, and name every track
      `browser-processing-unmeasured`; the first required stage then has
      `browserProcessingSeconds: null`, the reason and `completionSeconds:
      null` (AC-7); the suffix without a rate gives today's delay, 0 (AC-8).
   3. Boundary: a cold start (no fragment sample at all) on two tracks
      (AC-7); a single-fragment window (AC-4) and a two-fragment window (AC-5).
3. `Viewer` (`executeMs` on append samples): kept when 12.5 and when 0;
   `null` when absent, `null` or `undefined`; the whole append report refused
   (`appendService` null on a fresh viewer) for -1, `NaN`, infinity and the
   string "12".
4. `ViewerRequests`: the page's whole `appendService` reaches the forecast (a
   fragment whose appends executed 20 ms on the picture buffer and 40 ms on
   the sound buffer is measured at 10 + 40 ms over 1000 bytes, which only the
   whole report gives); samples reported for another output
   (`appendSessionId` differs) and samples of a report whose buffer capture is
   not valid measure nothing; the `playback readiness` log line carries
   `browserProcessing` with the sample count and rate.
5. Not covered, with the reason:
   1. A fragment loaded twice (two fragment samples with one `fragmentId`):
      design §2 uses each, but both join the same append samples by identity,
      so what each is charged is not settled by the specification.
   2. The gate on `browserAppends` alone: `fragmentService` has the same gate
      today, so with either refused the track is unmeasured; the two gate
      tests show the combined effect only.
   3. A suffix bound on two tracks (one measured, one not): the per-track
      bound is shown on one track; the `max_t` over tracks is not separately
      exercised.

Existing tests that pin the old shape (AC-11, updated by the implementer, not
edited here):

1. `test/no-torrent/playback-readiness.test.js`, "keeps the first required
   segment incomplete while browser stages lack future distributions":
   deep-equals the first required stage with `appendSeconds: null` and
   `appendReason`, which design §3.4 replaces by `browserProcessingSeconds`
   and `browserProcessingReason`.
2. `test/no-torrent/viewer-states.test.js`, "append service accepts advancing
   cumulative counters once and rejects stale counters": deep-equals append
   samples without `executeMs`; with design §4 they carry `executeMs: null`.
3. `test/no-torrent/playback-readiness.test.js`, "overlaps independent track
   processing and serves each released fragment on the shared link": its
   message says append completion has no supported distribution; its
   assertions hold.

### 4. Rules and exit

1. Every new test fails before the code, run 2026-11-12 on `2aefee5d` plus
   these tests, each listed under failing tests with its AC:
   1. AC-1 to AC-3: `Cannot find module
      '.../services/viewer/browser-processing.js'` (the measurement does not
      exist; the module is loaded inside each test, so the file still runs).
      15 tests, 15 todo, 0 fail.
   2. AC-4: `processing: undefined, expected 1` (no
      `browserProcessingSeconds`); `delay: 2, expected 3`.
   3. AC-5: `holdingBy.segment` 0, expected 1 (the second fragment is not
      delayed by the first's processing); `with the term ...: 1, expected 2`.
   4. AC-6: `the picture is processed ...: null, expected 1.5` (no processing
      charged; the sound's 2 s delivery holds today and guards against the
      link being held during processing).
   5. AC-7: `browserProcessing` undefined (the delay and reason equality hold
      today); `browserProcessingSeconds` undefined, expected null;
      `Cannot read properties of undefined (reading 'length')`.
   6. AC-8: `measured: 0, expected 12` (unmeasured 0 holds today).
   7. AC-9: `executeMs` undefined, expected 12.5; undefined, expected null;
      a report with `executeMs` -1 is accepted (`appendService` not null).
   8. AC-10: `readiness.browserProcessing` undefined (three tests); the log
      line's `browserProcessing` undefined.
   `playback-readiness.test.js`: 72 tests, 62 pass, 10 todo, 0 fail.
   `viewer-states.test.js`: 24 tests, 21 pass, 3 todo, 0 fail.
   `readiness-browser-processing.test.js`: 4 tests, 4 todo, 0 fail.
2. Deterministic: every forecast takes `now` as input and link and encoder
   readings as values; the `ViewerRequests` tests give the source stats and
   the viewer's reading and wait for the progress promise; no timers, no
   network, each wiring test with its own temp store root.
3. The `ViewerRequests` tests have a `timeout` of 10 s as a backstop; the
   others cannot block.
4. Exit: `npm test` in the proxy (lint plus every `test/no-torrent` test,
   under the refuse-torrent preload).
