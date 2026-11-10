# Tasks: select-ffprobe-by-capability

Parent: torrent-tv/meta#336, stage 6 (proxy), AC 20. Branch `fix/ttv-336-stable-tests`.
Acceptance criteria (ids used by the tests):

- **AC-20-A**: `auto-quality-step.test.js` passes 25 of 25 solo runs on the Mac and on the CI
  Linux runner; no fixture of the file writes a segment with `writeFile`; the precondition
  assertion fails if the old fixture is restored.
- **AC-20-B1**: the ffprobe binary is chosen at startup by capability (design.md, Decisions).
- **AC-20-B2**: the libxvid case of `avi-reordered-local.test.js` passes on the Mac and on Linux
  without a libxvid encoder available.
- **AC-20** as a whole: the full `npm test` exits 0 on the Mac and on Linux.

## 1. Code (implementer)

- [ ] 1.1 `services/media/ffprobe-selection.js`: `selectFfprobe`, `ffprobeCandidates`,
      `FfprobeUnavailableError` (design.md, Decision 3).
- [ ] 1.2 `services/media/probe-packets.js`: remove `bundledProbe()` and the default of
      `ffprobeBin`; throw `TypeError` when it is missing.
- [ ] 1.3 `bin/cli.js`: build the candidates from `@ffprobe-installer/ffprobe`, make the choice
      once before `startProxyServer`, pass `ffprobeBin` through `startProxyServer` and
      `server.js` to the `probePackets` port; add the `run` over `spawn` with a timeout.
- [ ] 1.4 `docs/layout.md` (entry, composition and media sections) names the module; a changeset.
- [ ] 1.5 Remove the `todo` markers of `test/no-torrent/ffprobe-selection.test.js` and of the two
      cases of `test/no-torrent/ffprobe-packets-local.test.js` in the code commit. After it the two
      `ffprobe-packets-local` cases pass where a qualifying ffprobe exists, are skipped with the
      reason where none does and `CI` is not set, and fail where `CI` is set and none does.

## 2. Test plan

### 2.1 Scope and risk

Files in scope and the tests that cover each:

| File | Tests |
| --- | --- |
| `services/media/ffprobe-selection.js` (new) | `test/no-torrent/ffprobe-selection.test.js` (unit, AC-20-B1) |
| `services/media/probe-packets.js` | the last case of `ffprobe-selection.test.js` (AC-20-B1); `ffprobe-packets-local.test.js` (a real ffprobe on a generated file), which now takes its binary from `test/no-torrent/helpers/ffprobe-binary.js` (`ffprobeForTest()`: one `selectFfprobe` over the real bundled binary and PATH, made once per process; no qualifying binary means the case is skipped with a logged reason, or fails where `CI` is set) and is marked `todo` until the code exists |
| `test/no-torrent/helpers/ffprobe-binary.js` (`decideFfprobe`) | `test/no-torrent/ffprobe-prerequisite.test.js` (unit, AC-20-B1, passing: the helper is test code) |
| `test/no-torrent/auto-quality-step.test.js` | itself, the fix (AC-20-A) |
| `test/no-torrent/avi-reordered-local.test.js`, `test/no-torrent/fixtures/avi-xvid-bframes.avi` and its sidecar | itself, the fix (AC-20-B2) |

Files out of scope:

- `bin/cli.js` and `server.js`: `bin/cli.js` starts the torrent pool, so no test starts it
  (`AGENTS.md`, "Checks"). The choice is a function the tests call with fakes; the call site is
  checked by review, and on the CI Linux runner by `ffprobe-packets-local.test.js`, which reads
  the bundled binary the way production did.
- `test/no-torrent/helpers/store-watch.js` (`untilWatchIsLive`): it waits for the platform watch;
  the group A fix does not depend on a watch at all, so the helper stays for the cases that write
  files and wait for the store to be told.
- The three cases of `auto-quality-step.test.js` that pass without the store knowing a piece
  (lines 466, 653, 670 before the fix) are covered by the same precondition assertion in
  `produceSegments()`; no separate test.
- A `--ffprobe-bin` option: no task asks for one.

Depth per risk area:

| Area | Risk | Depth |
| --- | --- | --- |
| Torrent startup | none reachable: every process is a fake, no test imports `bin/cli.js`, `TorrentPool` or WebTorrent | static check `node scripts/check-tests-start-no-torrent.mjs` plus `refuse-torrent.cjs` |
| ffprobe selection (startup, per host) | high: a wrong choice refuses every probe on a platform | every case of part 2.3 |
| Probe argument (`probePackets`) | low | the main negative case |
| Test fixtures (A, B2) | medium: they decide whether the suite is stable | the precondition assertion and the measured run counts of part 2.4 |

### 2.2 Types, levels and commands

All `node:test`. Unit: one module with fakes for the process and the logger. The AC-20-A and
AC-20-B2 files are integration level (real store, real files, real ffmpeg for the AVI case).
End-to-end is not used: no AC here needs a viewer path.

- AC-20-B1 (unit): `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/ffprobe-selection.test.js`
- AC-20-A (integration): `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/auto-quality-step.test.js`
  run 25 times solo on the Mac; the CI Linux runner runs it inside `npm test`.
- AC-20-B2 (integration): `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/avi-reordered-local.test.js`
- AC-20 (pass/fail command, the one CI runs): `npm test`.

### 2.3 Case coverage of `selectFfprobe`, `ffprobeCandidates` and `probePackets`

Positive:

1. The bundled candidate whose sections name `stream_side_data` is chosen; the result is
   `{ source, binary, version }` with the version read from `-version`.
2. A candidate after the chosen one is never run, and the chosen one is run for `-version` and
   `-sections` once each (the choice is made once).
3. The bundled candidate lacks the section (the real 4.4.1 text, 1 line containing the text, 0
   names equal to it) and the one on PATH has it: PATH is chosen.
4. The bundled candidate cannot be started (`EACCES`): PATH is chosen.
5. The bundled candidate's `-sections` exits 1 while printing the section: it does not qualify,
   PATH is chosen.
6. `ffprobeCandidates` lists bundled first and PATH second.

Negative:

7. A name that only begins with `stream_side_data` (`stream_side_data_list`) does not qualify.
8. No candidate qualifies (4.4.1 bundled, PATH empty output): exactly one log call in all, at
   `error`; its text names the bundled binary and `n4.4.1`, the PATH binary and `4.2.7`, and
   `stream_side_data` once per candidate; `FfprobeUnavailableError` is thrown with the same text.
9. A candidate that cannot be run is named in that single line with the reason (`spawn ffprobe
   ENOENT`).
10. `probePackets` without `ffprobeBin` throws `TypeError` and starts no process.

Boundary:

11. An empty candidate list: `FfprobeUnavailableError`, one line, no process run.
12. No bundled path: `ffprobeCandidates` returns only the PATH entry.

Not covered, with the reason: the real `run` over `spawn` (it is a thin edge over
`child_process`; the real binaries are exercised by `ffprobe-packets-local.test.js`); the process
exit of `bin/cli.js` on `FfprobeUnavailableError` (the entry point is not started by any test);
a `-sections` print larger than a buffer (the output of every measured build is 49 lines).

### 2.4 Rules and exit

1. Every new B1 test fails before the code exists, for the reason the AC describes. Command:
   `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/ffprobe-selection.test.js`.
   Expected: 12 `todo` tests under "failing tests", 11 with `ERR_MODULE_NOT_FOUND` for
   `services/media/ffprobe-selection.js` (the module is the code to be written; the module
   cannot be stubbed) and the `probePackets` case with `Missing expected exception (TypeError)`.
   Measured 2026-11-10 on the Mac: exactly this, the file exits 0.
2. The tests are satisfiable. A throwaway reference implementation (not committed) made all 12
   pass, and a variant that tests `includes("stream_side_data")` on the whole output failed 4
   of 12 (the PATH-after-lacks case, the prefix case, the single-line case and the unrunnable-
   candidate case): that mutant does not survive.
3. No test waits for time: fakes resolve at once; no timer is used.
4. AC-20-A measurements, on the Mac, Node 24.22.2, solo run of the file under `refuse-torrent.cjs`:
   before the fix 1 failure of 26 cases in the one run made (line 546; the analyst measured 19
   to 24 of 25 runs failing); after the fix 25 of 25 runs pass; with the old fixture restored in place of the new one, 7 of 26 cases
   fail on the precondition assertion in 6 of 6 runs.
5. Exit: `npm test` in this repository.
6. **A host with no qualifying ffprobe** (decided by the coordinator, 2026-11-10). The test writer's
   Mac has no `ffprobe` on PATH, and the bundled darwin-arm64 binary is 4.4.1. A check that needs
   the selected ffprobe (the two cases of `ffprobe-packets-local.test.js`, and any later one)
   calls `ffprobeForTest()`. When `selectFfprobe` finds no qualifying binary the check is skipped
   with `t.skip(reason)`: the reason names the missing prerequisite (an ffprobe whose
   `-sections` names `stream_side_data`) and carries the one-line message of
   `FfprobeUnavailableError`, which `selectFfprobe` has also logged. Never silently. Where `CI` is
   set (a non-empty value; CHOSEN, not measured) the same outcome throws, so the case fails and a
   CI runner cannot hide a regression of the selection behind a skip. The guard is tested by
   `ffprobe-prerequisite.test.js` (4 passing cases over `decideFfprobe`): a chosen binary is used
   with or without `CI`; no binary and no `CI` gives a skip whose reason holds `missing
   prerequisite`, `stream_side_data` and the selection's line; no binary with `CI` throws; an empty
   `CI` is not `CI`. Proof that the guard fails on bad input (2026-11-10): with the `CI` throw
   removed the CI case fails (1 of 4), and with the reason cut to the word `skipped` the reason
   case fails (1 of 4). End to end with a throwaway `selectFfprobe` on this Mac: without `CI` both
   cases are skipped with that reason (`skipped 2`, `fail 0`).

## 3. Group B2 (test-only), done

- [x] 3.1 The AVI was made on a Linux GitHub runner (`ubuntu-26.04`, 2026-11-10) by a throwaway probe
      branch with its own workflow, never on the PR branch (the branch, its run and its worktree
      are deleted), with the binary of `ffmpeg-static@5.3.0` the tests use there. Committed in
      `test/no-torrent/fixtures/avi-xvid-bframes.avi` (35892 bytes, sha256
      `01dfde0f...6e36`) with `avi-xvid-bframes.avi.md` (command, ffmpeg version and build,
      sha256). `.gitattributes` marks `*.avi` in that folder binary.
- [x] 3.2 The `libxvid` case copies that file instead of encoding; the other codecs encode as
      today. Solo run on the Mac: 25 of 25 pass (4 cases each). Linux: it does not need a libxvid
      encoder; the CI run of the pull request is the check.
