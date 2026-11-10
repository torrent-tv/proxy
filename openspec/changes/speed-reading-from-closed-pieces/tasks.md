# Tasks: speed-reading-from-closed-pieces (torrent-tv/meta#414)

Branch `fix/ttv-414-copy-output-capacity`. Pass/fail command: `npm test` in the
proxy (lint plus every `test/no-torrent` test). No check on this Mac starts a
real torrent: `EncodeRun` is exercised with a fake ffmpeg process (progress on
stdout, closed-piece names on fd 3) and a fake clock; `EncodeCost` and
`EncodeAdmission` with plain values.

## Acceptance criteria

| id | criterion | check |
|---|---|---|
| AC-1 | A run's reading at a published piece is (end of that piece on the timeline − end of the previous reading's piece, or the run's `startSeconds`) over (working ms at the moment the piece was named closed − working ms at the previous reading, or 0), input waits and stops left out. Field sequence H1 of design §1.2: start 93.750 s, `pieceEndSeconds(9)` = 104.167, input waits 0.4 s in all, a progress report of 10.40 s before the last input wait ends, #9 named at 1.684 s → reading 10.417/1.284 s. | unit, `test/no-torrent/encode-run.test.js` (fake process and clock) |
| AC-2 | Field sequence H2: the same run whose only progress report before publication is 0.04 s, and no report after it → the same reading as AC-1. | unit, same file |
| AC-3 | A second piece is measured from the first: pieces ending 40 s and 50 s, named at 2.0 s and 3.0 s of work → second reading 10x. | unit, same file |
| AC-4 | No reading when `pieceEndSeconds(index)` is not finite, or when the film or working time between readings is not > 0; progress reports alone never produce a reading. | unit, same file |
| AC-5 | `EncodeRuns` gives every run `pieceEndSeconds` from its output's timeline (end of piece `index`; the file's duration for the last piece). | unit or integration with a fake spawn (as `run-starts-inside-its-input.test.js`) |
| AC-6 | The first reading of a run logs once `encode-run #A..#B on <addr>: first speed reading <s>x — <film>s of film to the close of #N over <working>s of its own work, <idle>s waiting for input or stopped left out`; later readings of that run log nothing. | unit with a recording logger |
| AC-7 | Field case end to end with plain values: `EncodeCost.learnFrom` fed the AC-1 reading with 16 % left to encoders prices the copy so that `EncodeAdmission.admitsWatching` admits the output on an idle machine with 83 % to spare (no live run, no held output). Before the change the same field figures (reading 0.024x) refuse it. | unit, `test/no-torrent/encode-admission.test.js` or `encode-cost.test.js` |
| AC-8 | The two tests listed in design §5 are rewritten to the reading from closed pieces with their intent kept; `npm test` exits 0 after every commit; docs of design §3.4 and the changeset of design §3.5 are present. | CI, review |
| AC-9 | Field (HA host only, skill `ha-field-check`), after release and add-on update: on the idle proxy open `Below.S01E01.1080p.rus.LostFilm.TV.mkv`, play 60 s, close, open it again, then open a second 1080p MKV that is copied. Copy proxy and page logs to `/Users/silentimp/Work/torrent-tv/logs/session-logs-<date>-ttv414/` (never commit them), attach them to the issue, quote the proving lines. Pass: every `POST /api/transcode-sessions` answers 200; no `not opened for this viewer` line for a copy output opened while no encoder runs; every `first speed reading` line of a copy output is above 1x and not above (film / ms named) of the same run's `written by the encoder +Xms` line; every `copies at <x>x` line is above 1x. | end to end on HA |

## Tasks

1. [x] Test writer (fresh): write the test plan into this file under "Test
       plan" (skill `writing-tests`), write tests for AC-1…AC-7 marked `todo`,
       rewrite the two tests of design §5, show each new test fails for its
       AC's reason, commit `test(proxy): AC-1 … AC-7 speed readings from closed pieces #ttv-414`.
2. [x] Implementer (fresh, worktree from the test commit): design §3.1–3.5 in
       that order, removing the `todo` markers of the tests it makes pass;
       `npm test` exits 0.
3. [ ] Reviewer approves on the current head; CI green; merge by rebase.
4. [ ] Release; HA add-on update; AC-9.

## Test plan

Written by the test writer (skill `writing-tests`) from the issue and this
change only. The figures are the field figures of design §1.

### 1. Scope and risk

1. Files in scope and the tests covering each:
   1. `services/encode/EncodeRun.js` (reading per published piece, the
      `pieceEndSeconds` port as a public instance property like `indexOfName`,
      the first-reading line): `test/no-torrent/encode-run.test.js` (AC-1,
      AC-2, AC-3, AC-4, AC-6; the two tests of design §5 rewritten, AC-8).
   2. `services/encode/EncodeRuns.js` (passes `pieceEndSeconds` from the
      timeline): `test/no-torrent/run-is-told-where-its-pieces-end.test.js`
      (AC-5), through the real `EncodeRuns` and `EncodeInputs`.
   3. `EncodeCost.learnFrom` and `EncodeAdmission.admitsWatching`, unchanged,
      read together with the new reading:
      `test/no-torrent/copy-admitted-on-an-idle-machine.test.js` (AC-7).
   4. `test/no-torrent/helpers/encode-run.js`: `measureSpeed` made
      47 call sites (20 test files) read a speed from progress reports. It now
      also tells the run, by assigning `run.pieceEndSeconds`, where each piece it
      names ends, so those reads are the film of closed pieces over the
      working time between closes whichever implementation is present. It adds
      no assertion. It needs `pieceEndSeconds` to be a writable instance
      property of `EncodeRun`.
   5. Documentation (design §3.4) and the changeset (design §3.5): no
      `node:test` test; checked by the reviewer and by `changeset status` in CI.
2. Files out of scope:
   1. `services/encode/encoder-readings.js` and its test
      (`encoder-readings.test.js`): `workDeltaBetween` is unchanged.
   2. `services/encode/RunClock.js`: unchanged; its exclusion of input waits
      and stops is checked through the run's readings (AC-1, AC-3, AC-8).
   3. `EncodeCost` and `EncodeAdmission` arithmetic: unchanged, only the one
      field case of AC-7 is added; their own tests stay.
   4. Server, ha-addon, infra: no change. AC-9 is the HA field check.
3. Depth per risk area:
   1. Speed readings feeding prices, the open estimate and the forecast: high.
      Every case of part 3 below is written.
   2. Run publication and the order of the close moment against the `finally`
      that deletes it: high (AC-1 variant with a piece published only when the
      next is named).
   3. Admission of copies on an idle machine: medium; the one field case end to
      end plus its negative control.
   4. Wiring in `EncodeRuns`: low; one positive case for a middle piece and one
      for the last piece.
   5. Torrent startup: none touched. Every test uses a fake process, a fake
      clock and fakes at the input boundary; `EncodeRuns` is built over an
      encoder path that names no program, as in
      `run-starts-inside-its-input.test.js`. `npm test` runs under
      `refuse-torrent.cjs` and `scripts/check-tests-start-no-torrent.mjs`.

### 2. Types and levels, with commands

| AC | level | file |
|---|---|---|
| AC-1, AC-2, AC-3, AC-4, AC-6, AC-8 | unit (real `EncodeRun`, fake process, injected clock) | `encode-run.test.js` |
| AC-5 | integration (real `EncodeRuns`, `EncodeInputs`, manager; fake resolution, reads and encoder path) | `run-is-told-where-its-pieces-end.test.js` |
| AC-7 | integration (real `EncodeRun`, `EncodeCost`, `EncodeAdmission`; fake process, clock and host figures) | `copy-admitted-on-an-idle-machine.test.js` |
| AC-9 | end to end on the HA host only (skill `ha-field-check`) | none here |

One file: `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/<name>.test.js`.

### 3. Case coverage

For `EncodeRun` readings (all with a fake clock; waits are `inputWaitBegins` /
`inputWaitEnds`):

1. Positive: field H1 (start 93.750, end 104.167, waits 0.4 s, report 10.40 s
   before the last wait ends, named at 1.684 s) reads 10.417 s over 1.284 s
   (AC-1); field H2 (only report 0.04 s) reads the same (AC-2); a piece
   published only when the next is named is measured to its own close (AC-1);
   a second piece is measured from the first, with waits before both (AC-3);
   a one-piece run after a 30 s wait, with 3.5 s and 4 s of film (AC-8).
2. Negative: end `undefined`, `null`, `NaN`, `Infinity` (AC-4); end at or before
   the run's start (AC-4); no working time since the last reading (all idle,
   AC-4); a reading never follows progress reports after the close (AC-1).
3. Boundary: the first piece (baseline = `startSeconds`, 0 ms); film exactly 0;
   working time exactly 0; the next piece after a refused one is measured from
   where the last reading was (AC-4); first-reading line for the first of one
   and the first of three pieces (AC-6).
4. Admission (AC-7): reading 8.11x read at 16 % for encoders, asked at 83 % to
   spare, nothing running: admitted at about 42x, priced near 0.0197 s/s. Not
   a todo: with a plain reading of 0.024x the same figures are refused with
   0.12x (this passes before and after; it pins the arithmetic the change
   leaves alone).
5. Wiring (AC-5): the run from #188 on a copied output with uneven cuts is
   told the end of #188, #189 and #262 on its timeline, and of the last piece
   the file's duration.

Cases deliberately not covered:

1. A stop or a tentative piece: unchanged paths, already covered by the
   existing tests of `encode-run.test.js`.
2. Logging number formats beyond what the tests pin (speed 2 decimals,
   seconds 3 decimals): chosen by the implementer from the logs of design §1.
3. Out-of-range or non-integer indexes given to `pieceEndSeconds` by
   `EncodeRuns`: the run only asks for pieces it published.

### 4. Rules and exit

1. Each new test fails before the code exists, for the reason of its AC. Run
   the file with the command of part 2; each todo test is listed under
   "failing tests" with its `# AC-<n>`: AC-1, AC-2, AC-3, AC-4, AC-6, AC-8 and
   AC-7 fail because the run's reading comes from progress reports (no
   reading, or a reading of the wrong film, so the price is wrong and the
   output is refused or the log line is missing); AC-5 fails because the run
   has no `pieceEndSeconds`.
2. Deterministic: no timers or sleeps; the clock is injected; AC-5 awaits
   `setImmediate` turns, not time.
3. The AC-5 tests carry a runner `timeout` of 10 s as a backstop.
4. Exit: `npm test` in the proxy.
