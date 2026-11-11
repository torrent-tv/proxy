# Tasks: Cache and retry the native downloads of npm ci in CI

Issue torrent-tv/meta#338. Branch `ci/ttv-338-npm-ci-cache-retry`. Commits, in
order: this change (`docs(proxy)`), the changeset (`chore(proxy)`), the failing
tests (`test(proxy)`), the code (`ci(proxy)`). Exact YAML and test contents:
design.md.

## 1. Tests first (test writer)

- [x] 1.1 `test/no-torrent/retry-command.test.js`: checks 1-5 of design.md
      "Tests" for `scripts/retry.mjs`. Temp directories from `mkdtempSync`
      under `os.tmpdir()`, removed in `after`.
      Shown: ce6aca68 (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739067946).
- [x] 1.2 `test/no-torrent/ci-native-downloads.test.js`: checks 1-5 of
      design.md "Tests" on `.github/workflows/main.yml`, read as text.
      Shown: ce6aca68 (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739067946).
- [x] 1.3 Run `node --require ./test/no-torrent/support/refuse-torrent.cjs
      --test test/no-torrent/retry-command.test.js
      test/no-torrent/ci-native-downloads.test.js`: every check fails, for the
      missing retry or the missing step/field, not for a test error. `npm run
      lint` passes.
      Shown: the test writer's report: all 5 retry checks failed with `Cannot find module`
      for `scripts/retry.mjs`, the workflow checks with `id` undefined and no step
      "Restore native download cache"; against a scratch implementation all 10 passed;
      `biome lint .` was clean (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739067946).
- [x] 1.4 Commit `test(proxy): pin the retry and the native download cache of
      npm ci #ttv-338`.
      Shown: commit ce6aca68, which became b0527a38 when rebased onto `main`
      (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739067946, 6739110637).

## 2. Code (implementer, without the test writer's context)

- [x] 2.1 `scripts/retry.mjs` as in design.md "`scripts/retry.mjs`".
      Shown: `scripts/retry.mjs` in 1d83e31d, no deviation from design.md
      (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739110637).
- [x] 2.2 `.github/workflows/main.yml`: `id: node` on the `checks` job's
      setup-node (`:38`); replace `Install dependencies` (`:87-88`) with the
      three steps of design.md "The `checks` job". Nothing else in the file
      changes (the `release` job's setup-node keeps no id).
      Shown: the `checks` job of `main.yml` in 1d83e31d, no deviation from design.md
      (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739110637).
- [x] 2.3 `npm test` passes locally (the two new tests included).
      Shown: the two new test files passed 10 of 10 locally and `npm run lint` passed
      (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739110637); the
      `Checks` job on head 1d83e31d ran 3083 tests, 3083 pass, 0 fail
      (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739525755).
- [x] 2.4 Commit `ci(proxy): cache and retry the native downloads of npm ci
      #ttv-338`.
      Shown: 1d83e31d, merged with proxy#50 as 2b58e9b4 and released as 2.107.68
      (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739525755).

## 3. Constraints

- `Dockerfile`, `package.json`, `package-lock.json` and the `release`/`build`
  jobs do not change; no `--ignore-scripts`, no `continue-on-error`, no
  `restore-keys` on the new cache.
- Only `test/no-torrent/` checks run; no real torrent is started.
- Actions pinned as in the file: `actions/cache/restore@v6`,
  `actions/cache/save@v6`.

## 4. Acceptance (issue #338)

- [x] 4.1 AC 1: the pull request's first run (new key: miss) passes; its log
      shows `Native download cache: miss` and the save step saving
      `native-downloads-Linux-X64-node-v24…`. Re-run the checks job (same
      lockfile: hit); it passes, its log shows `Cache restored from key:
      native-downloads-…`, `Native download cache: true`, `ffmpeg is installed
      already.`, no `gyp http GET`, and the save step skipped. Record both run
      ids (and attempts) on the issue. If the first run's log shows no `gyp http
      GET`, record that the runner had the headers already (design.md
      Estimates).
      Shown: PR run 42610540433 attempt 1 (miss) and attempt 2 (hit), main push run
      42611728295 (miss) and `workflow_dispatch` run 42612945862 (hit), all green
      (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739525755).
- [x] 4.2 AC 2: `test/no-torrent/retry-command.test.js` passes in CI (check 1:
      first attempt fails, second succeeds, exit 0).
      Shown: main run 42611728295, the case "fails once and then passes"
      (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739525755).
- [x] 4.3 AC 3: `git diff origin/main -- Dockerfile` is empty.
      Shown: `git diff 049a88a5 2b58e9b4 -- Dockerfile` is empty
      (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739525755).
- [x] 4.4 AC 4: all checks of the pull request are green.
      Shown: Checks and Image build passed on 1d83e31d, 3083 pass, 0 fail
      (https://github.com/torrent-tv/meta/issues/338#issuecomment-6739525755).
