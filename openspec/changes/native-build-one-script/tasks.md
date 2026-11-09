## 1. Test plan

Written by the test writer before any test (meta AGENTS.md, "Writing tests:
the test plan comes first"). Covers AC-1 to AC-4 of `design.md`.

### 1.1 Scope and risk

Files in scope and the tests that cover them:

| File | Test |
|---|---|
| `scripts/install-native.sh` (new) | `test/no-torrent/install-native-script.test.js` (runs it) and `test/no-torrent/install-native-package.test.js` (reads it) |
| `package.json` (`files`) | `test/no-torrent/install-native-package.test.js` |
| `Dockerfile` | `test/no-torrent/install-native-image.test.js` |
| `.github/workflows/main.yml` (job `build`) | `test/no-torrent/install-native-image.test.js` |

Out of scope, not tested here:

- `ha-addon/torrent_tv_proxy/Dockerfile` and `run.sh` (AC-1 for the add-on,
  AC-6, AC-7): another repository, changed after the proxy release; checked by
  `grep` on add-on `main` and on the Home Assistant host by the coordinator.
- `.changeset/`: checked by CI's `check-changesets`.
- `bin/thread-pool.js`: unchanged by this task.
- Line endings of the Dockerfile: CI's `check-line-endings`.
- A real `docker build` and the throwaway pull request with a broken
  Dockerfile (AC-4 second half, AC-5): run on GitHub by the coordinator.

Depth per risk area:

- **Native build (release scripts, high):** the script decides whether the
  shipped proxy has WebRTC and which `utp-native` it runs. Every step of
  design Decision 1 gets positive, negative and boundary cases.
- **Package contents (medium):** the one new file in `files`, its LF and its
  executable bit; main positive case and the negative (no whole `scripts/`).
- **Image and CI wiring (low):** Dockerfile and workflow read as text; main
  positive case and one negative per AC.
- **Torrent startup:** none. No test runs the proxy, `docker`, the real `npm`
  or anything that imports WebTorrent. The proxy entry point is only named
  inside the Dockerfile text the test reads.

### 1.2 Types and levels

All `node:test`. Each file runs on its own with
`node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/<name>.test.js`.

- AC-1: unit, static — `install-native-image.test.js` reads `Dockerfile` as
  text.
- AC-2: integration at the process edge — `install-native-script.test.js`
  runs `sh scripts/install-native.sh <dir>` against a package directory built
  in the test's own temp directory. `PATH` starts with a directory of fakes:
  `npm` (logs its working directory, arguments and
  `npm_config_build_from_source`; fails or succeeds as the case asks; writes
  the files a real rebuild or install would write), `node` (answers
  `-p process.versions.node` with the case's version and passes every other
  call to the real node) and `sleep` (logs its argument, returns at once).
  `INSTALL_NATIVE_RETRY_DELAY=0` unless the case is the default delay. The
  script is started from a working directory other than the package
  directory.
- AC-3: unit, static — `install-native-package.test.js` reads `package.json`,
  the script's bytes and `git ls-files -s` of the script.
- AC-4: unit, static — `install-native-image.test.js` reads `Dockerfile` and
  `.github/workflows/main.yml` as text. The broken-Dockerfile pull request is
  the coordinator's (tasks 4.1).
- End-to-end: none here; AC-6 is on the Home Assistant host after the add-on
  release.

### 1.3 Cases

`scripts/install-native.sh` (AC-2). Unless the case says otherwise the
package is valid: `engines.node` `>=24`, `overrides['utp-native']`
`npm:@torrent-tv/utp-native@2.5.3-ttv.9`, ours at
`node_modules/utp-native`, node `24.11.0`, every `npm` call succeeds and the
source build writes `utp_native.node` with `obj.target` and `.deps`.

Positive:

- a valid package exits 0;
- prints `install-native: node v24.11.0 (floor 24)`;
- `npm rebuild node-datachannel` runs once when it succeeds at once, and no
  retry line is printed;
- prints `utp-native: the proxy pins npm:@torrent-tv/utp-native@2.5.3-ttv.9`;
- when the top `utp-native` is already ours, nothing is installed;
- the source build runs `npm rebuild utp-native` with
  `npm_config_build_from_source=true`;
- prints `utp-native: our build at <path>` for the built binary;
- every `npm` call runs in the package directory, never with `--global`;
- the `npm` calls come in the order of the steps: node-datachannel, then
  (when needed) the install, then the source build;
- nested `utp-native` copies (depth 3 and depth 5) are removed, the top one
  stays;
- `obj.target` and `.deps` under every `build/Release/` are removed, the
  `.node` files stay.

Negative:

- no argument: usage on stderr, exit 2, `npm` never called;
- a directory without `package.json`: usage on stderr, exit 2, `npm` never
  called;
- node one major below the floor: the `FATAL … requires Node 24 or newer;
  found v23.11.1` line, exit 1, `npm` never called;
- `engines.node` `^24`: `FATAL … engines.node must be ">=N", found ^24`,
  exit 1;
- `engines.node` absent: a `FATAL … engines.node must be ">=N"` line, exit 1;
- `npm rebuild node-datachannel` fails all 5 times: 5 calls, retry lines for
  attempts 1–4 only, `FATAL … node-datachannel has no native binary; the
  proxy would have no WebRTC`, exit 1, no `utp-native` step runs;
- `npm rebuild node-datachannel` succeeds but writes no `.node`: the same
  FATAL, exit 1;
- `overrides['utp-native']` absent: `FATAL … pins no utp-native build of
  ours: undefined`, exit 1;
- `overrides['utp-native']` a registry range (`^2.5.3`): the same FATAL with
  that value, exit 1;
- the top `utp-native` is missing: `npm install --omit=dev --ignore-scripts
  --no-save --no-audit --no-fund utp-native@<spec>` runs in the package
  directory;
- the top `utp-native` is a foreign package: the same install runs;
- the source build fails: `WARNING: utp-native build failed; peer
  connections stay TCP-only` on stderr, exit 0;
- a `utp_native.node` in a package not named `@torrent-tv/utp-native`:
  `FATAL … <path> is not our build`, exit 1.

Boundary:

- node exactly at the floor (`24.0.0`) passes;
- `engines.node` `>=24.1` (not an integer) is refused;
- `node-datachannel` fails twice then succeeds: 3 calls, retry lines for
  attempts 1 and 2 only, exit 0 (the first success stops the loop);
- `node-datachannel` fails 4 times and the 5th succeeds: exit 0 (the last
  attempt counts);
- `INSTALL_NATIVE_RETRY_DELAY` unset: the retry line says `retrying in 10s`
  and `sleep` is given `10`;
- no `utp_native.node` at all (source build failed): exit 0 and no
  provenance line;
- a `utp_native.node` under `build/Release/obj.target/` is not checked for
  provenance;
- a directory named `utp-native-legacy` (not exactly `utp-native`) is not
  removed;
- an `obj.target` directory that is not directly under `build/Release/` is
  not removed.

Deliberately not covered:

- a scoped `node_modules/@scope/utp-native` (depth 2): no such package exists
  in the tree, and the design defines removal by depth only;
- what the script downloads: it downloads nothing itself and every `npm` is
  the fake; a static check that the script names `npm` and `node` only by name
  (never an absolute path) guards that the fake is the one that runs;
- real compilation, real `npm rebuild`, Alpine `ash`: covered by the image
  build in CI (AC-5).

Package (AC-3):

- positive: `files` holds `scripts/install-native.sh`;
- positive: the other `files` entries are exactly the ones before this
  change (it is the only new file);
- negative: `files` has no `scripts/` folder entry and no other `scripts/…`
  entry;
- positive: the script has no CR byte;
- positive: git records the script with mode `100755`.

Dockerfile and workflow (AC-1, AC-4):

- AC-1: `Dockerfile` contains `node-datachannel: build attempt` zero times;
- negative: `Dockerfile` runs no `npm rebuild` (the build lives only in the
  script);
- positive: stage `dependencies` copies `scripts/install-native.sh` and runs
  it on `/app` after the `RUN` with `npm ci`;
- positive: the final stage runs the proxy CLI with `--help` after `USER
  app`;
- positive: job `build` runs `docker build`;
- negative: job `build` runs no `docker run`;
- positive: `release` needs both `checks` and `build`.

### 1.4 Rules and exit

- Every new test fails before the code exists, for the AC's reason:
  - `install-native-script.test.js`: `sh` cannot open
    `scripts/install-native.sh` (no such file), so exit codes, lines and
    `npm` calls differ from the expected ones;
  - `install-native-package.test.js`: `files` lacks
    `scripts/install-native.sh`, the script file does not exist and git does
    not list it;
  - `install-native-image.test.js`: the Dockerfile still holds the retry loop
    (`node-datachannel: build attempt`), `npm rebuild`, no `install-native.sh`
    and no `--help` run; job `build` still has `docker run`. Job `build`
    already runs `docker build` and `release` already needs `build`, so those
    two tests pass before and after (they guard that both stay).
  Command: `node --require ./test/no-torrent/support/refuse-torrent.cjs --test
  test/no-torrent/install-native-*.test.js`.
- Deterministic: no real sleep (`sleep` is a fake, the delay is `0`), no
  network, the real `npm` never runs, every file is inside the test's own
  temp directory; tests do not depend on order.
- One behaviour per test, named as a sentence.
- Exit: `npm test` exits 0 (lint plus every `no-torrent` test).

## 2. Tests (failing, one commit)

- [ ] 2.1 Tests from the plan, committed failing: `test(proxy): …`

## 3. Implementation (one or more commits, tests untouched)

- [x] 3.1 `scripts/install-native.sh` as in design Decision 1
- [x] 3.2 `package.json` `files` gains `scripts/install-native.sh`
- [x] 3.3 `Dockerfile` runs the script after `npm ci`, `--help` in the final stage
- [x] 3.4 CI `build` job builds only; release keeps needing it
- [x] 3.5 `.changeset/build-ttv-302-native-build-script.md`
- [x] 3.6 `npm test` exits 0

## 4. After merge (coordinator)

- [ ] 4.1 Throwaway PR with a broken Dockerfile fails `Image build` (AC-4)
- [ ] 4.2 Proxy release published; add-on `PROXY_VERSION` points at it
- [ ] 4.3 Add-on PR: Dockerfile runs the script, `run.sh` drops `UV_THREADPOOL_SIZE` (AC-1, AC-7)
- [ ] 4.4 Add-on released; HA update log shows the provenance line, proxy starts (AC-6)
