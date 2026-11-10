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

1. [ ] Test writer (fresh): write the test plan into this file under "Test
       plan" (skill `writing-tests`), write tests for AC-1…AC-7 marked `todo`,
       rewrite the two tests of design §5, show each new test fails for its
       AC's reason, commit `test(proxy): AC-1 … AC-7 speed readings from closed pieces #ttv-414`.
2. [ ] Implementer (fresh, worktree from the test commit): design §3.1–3.5 in
       that order, removing the `todo` markers of the tests it makes pass;
       `npm test` exits 0.
3. [ ] Reviewer approves on the current head; CI green; merge by rebase.
4. [ ] Release; HA add-on update; AC-9.

## Test plan

To be written by the test writer (skill `writing-tests`).
