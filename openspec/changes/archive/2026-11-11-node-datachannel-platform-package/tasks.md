## 1. Test plan

Written by the test writer before any test. Covers AC-21 and AC-22 of
`design.md`.

### 1.1 Scope and risk

Files in scope and the tests that cover them:

| File | Test |
|---|---|
| `scripts/install-native.sh` (step 2) | `test/no-torrent/install-native-script.test.js` |
| `package.json`, `package-lock.json` (0.33.6) | none of its own: the full `npm test` and the image build load the real package; the script tests use a fake package |
| `Dockerfile`, `AGENTS.md`, `native-build-one-script/design.md` (comments) | none: prose |

Out of scope, not tested here:

- `ha-addon/torrent_tv_proxy/Dockerfile` comment: another repository, another
  pull request.
- That the real 0.33.6 binding loads and carries a message: measured by the CI
  probe run 42927294266 and by the image build's `--help` stage; no test here
  may require the real package (a real WebRTC binding next to a torrent proxy
  is kept out of the local checks).
- `install-native-image.test.js` and `install-native-package.test.js`: they
  read the Dockerfile, the workflow and `package.json` `files`; this change
  touches none of what they assert.
- Steps 1 and 3 to 8 of the script: unchanged; their existing cases in
  `install-native-script.test.js` stay and must keep passing.

Depth per risk area:

- **Native build (release scripts, high):** the step decides whether the shipped
  proxy has WebRTC. Positive case, both negative cases (require throws,
  package absent), and the absence of the removed call.
- **Torrent startup:** none. The script only requires a package from the test's
  own temp directory, and that package is a fake with a one-line `index.js`.
  The real `node-datachannel`, WebTorrent and the proxy entry point are never
  reachable: nothing is installed in the temp directory and `npm` is a fake.

### 1.2 Types and levels

All `node:test`. One command runs the file:

`node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/install-native-script.test.js`

- AC-21: integration at the process edge. The test runs `sh
  scripts/install-native.sh <dir>` against a package directory built in its
  own temp directory, with fakes first on `PATH` (`npm` that logs its calls,
  `node` that answers the version probe and passes every other call to the
  real node). `node_modules/node-datachannel` in that directory is a fake
  package: `loads` (exports `getLibraryVersion` returning `0.24.6`, package
  version `0.33.6`), `throws` (throws an `Error` whose message has two lines)
  or `absent`. The real node does the `require`.
- AC-22: integration, same file: the recorded fake `npm` calls hold no
  `rebuild` of `node-datachannel`.

### 1.3 Case coverage

Positive:

- the binding loads: exit 0 and the stdout line
  `install-native: node-datachannel 0.33.6: binding loads (libdatachannel 0.24.6)`.
- the script makes no `npm rebuild node-datachannel` call.

Negative:

- the require throws a two-line error: exit non-zero; exactly one stderr line
  starts with `FATAL: install-native:`; it names `node-datachannel` and holds
  the error's first line but not its second; no `binding loads` line; no
  utp-native install or rebuild call follows.
- the package is absent: exit non-zero; a FATAL line names `node-datachannel`
  and is not the removed `no native binary` message; no `binding loads` line.

Boundary and cases deliberately not covered:

- A package whose `getLibraryVersion` throws or is missing: the same require
  path reports it; one negative case (require throws) stands for the class and
  the exact wording is the implementer's.
- A package whose `package.json` is unreadable: not a state `npm ci` leaves;
  the absent case covers the missing package.
- Retries: there are none; the old retry cases (1 to 5 attempts, the delay,
  `sleep`) are deleted with the loop.
- Consequence for existing cases: the fake `npm` still writes
  `node_datachannel.node` on `rebuild node-datachannel`, as 0.32.3 did, so the
  unchanged cases pass on the old and the new script. The implementer may
  delete that branch of the fake together with `isNdc` once no case needs it.

### 1.4 Rules and exit

Each new test fails before the code exists, for the reason the AC gives, with
the command of 1.2 (node:test lists a `todo` failure under "failing tests"):

- binding loads: `exit 0`, stdout holds the node line and the utp-native lines
  but no `binding loads` line (`expected` the regular expression).
- require throws: exit 0 where non-zero is expected (the old script never
  loads the package).
- package absent: exit 0 where non-zero is expected.
- no rebuild: 1 recorded `npm rebuild node-datachannel` call where 0 are
  expected.

Tests are deterministic: no timers, no network, a `timeout` of 60 s on every
script run as the backstop. Exit is `npm test` (lint plus every `no-torrent`
test); it exits 0 with the four tests still marked `todo`, and the implementer's
commit removes the markers.

## 2. Implementation tasks (implementer)

- [x] 2.1 `package.json`: `node-datachannel` `0.32.3` to `0.33.6` in `dependencies`; refresh
      `package-lock.json` with the repository's pinned npm (`npm install --package-lock-only
      --ignore-scripts`). `werift` stays. The `allowScripts` entry `node-datachannel@0.32.3`
      stays (the nested copy under `webrtc-polyfill`).
      Shown: `package.json` on `main` has `node-datachannel` `0.33.6`, exact, and the lock file
      was made with `--ignore-scripts` (merged proxy#71, commit 81628506; released as 2.107.89).
      `werift` stayed at 0.24.4 in that pull request; the dependency run of 2026-11-11 raised it
      to 0.27.0 (proxy run 42989425984, released as 2.107.92).
- [x] 2.2 `scripts/install-native.sh`: replace step 2 as in `design.md` Decision 1; remove
      `INSTALL_NATIVE_RETRY_DELAY` and its header paragraph; update the header line "builds and
      checks" so it says what the script does now.
      Shown: step 2 of `scripts/install-native.sh` on `main` loads the package and logs
      `install-native: node-datachannel <v>: binding loads (libdatachannel <x>)`; `npm rebuild
      node-datachannel` and `INSTALL_NATIVE_RETRY_DELAY` occur nowhere in the script (`grep -c`
      prints 0). The image build log of proxy#71 shows `install-native: node-datachannel 0.33.6:
      binding loads (libdatachannel 0.24.6)` (meta#336, implementer result, 2026-11-11 00:15
      UTC).
- [x] 2.3 Comments that describe the old behaviour: `Dockerfile` (the `npm ci` comment and the
      `--help` comment name node-datachannel's binding), `AGENTS.md` "Gotchas",
      `openspec/changes/archive/2026-11-11-native-build-one-script/design.md` (steps 2 and the retry text; mark it
      superseded by this change).
      Shown: commit 81628506 corrected the `Dockerfile` comments and `AGENTS.md` "Gotchas";
      `openspec/changes/archive/2026-11-11-native-build-one-script/design.md` is marked superseded in part by this
      change (line 3).
- [x] 2.4 Remove the `todo` markers of the four tests in
      `test/no-torrent/install-native-script.test.js` without changing their bodies.
      Shown: `test/no-torrent/install-native-script.test.js` on `main` holds no `todo` marker;
      commit 81628506 removed the four markers and left the bodies alone, and 5c1a7ac8 later
      dropped the rebuild leftovers of the fake `npm`.
- [x] 2.5 A changeset in `.changeset/`.
      Shown: the changeset of commit 81628506 is versioned as 2.107.89 in `CHANGELOG.md` ("The
      proxy now takes its WebRTC binary from the per-platform packages of node-datachannel
      0.33.6 and checks at install that it loads.").
- [x] 2.6 `npm test` exits 0. Nothing here starts a torrent; `--help` of a local build is
      allowed.
      Shown: Checks and Image build of proxy#71 passed; on this Mac `npm test` passed with 3283
      tests and 0 failures and nothing started a torrent (meta#336, implementer result,
      2026-11-11 00:15 UTC). Proxy#71 and the follow-up proxy#72 are merged.
- [x] 2.7 ha-addon `Dockerfile` comment: a separate pull request after the proxy release.
      Shown: ha-addon#18 (`docs(addon): describe node-datachannel as a platform package, not a
      build #ttv-336`) is merged (2026-11-11 00:40 UTC) after the proxy release that carries
      proxy#71; it also corrected the add-on `AGENTS.md` and the `Dockerfile` line about
      utp-native.
