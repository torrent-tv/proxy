## Context

Issue: torrent-tv/meta#336, stage 9. Facts below are measured by the CI probe
run 42927294266 (Alpine 3.24.4, npm 11.12.1, x86_64 and aarch64) unless marked
otherwise.

### Facts

1. `node-datachannel` 0.33.x has no install script and no `prebuild-install`.
2. Its binary is shipped as optional npm packages, one per platform:
   `@node-datachannel/linux-x64-musl`, `@node-datachannel/linux-arm64-musl` and
   seven others, each with `libc: musl` where applicable. `npm ci
   --ignore-scripts` installs the matching one by itself.
3. `npm rebuild node-datachannel` does nothing for 0.33.x. In the current
   tree it rebuilt only the nested 0.32.3 copy pulled by `webrtc-polyfill`;
   nothing loads that copy, because the worker redirects `webrtc-polyfill` to
   werift.
4. `scripts/install-native.sh` step 2 then requires
   `node_modules/node-datachannel/build/Release/*.node`. 0.33.x never writes
   that path, so the script stops with `FATAL: install-native:
   node-datachannel has no native binary; the proxy would have no WebRTC`.
5. With 0.33.6: `require("node-datachannel")` works, a loopback data channel
   carries a message, `getLibraryVersion()` answers libdatachannel 0.24.6, and
   `--help` exits 0. Only `install-native.sh` fails.
6. `getLibraryVersion` is part of the package's API (`dist/types/lib/index.d.ts`
   of 0.32.3 declares it; read on this machine, not part of the probe).

## Decisions

### 1. Step 2 is a load check

Step 2 of `install-native.sh` is replaced. The one fact it needs is "this node
can load the binding the install left", and only a `require` from the package
directory answers it, whatever file or platform package the binding comes from
(one owner of the fact: the package's own loader).

- It runs `node` with the package directory as working directory, requires
  `node-datachannel`, reads the version from the package's `package.json` and
  the libdatachannel version from `getLibraryVersion()`.
- Success: `install-native: node-datachannel <v>: binding loads (libdatachannel
  <x>)` on stdout, then step 3.
- The require throws: exit 1 and `FATAL: install-native: node-datachannel
  binding does not load: <first line of the error>` on stderr. Only the first
  line, so one FATAL is one line; the full error is not needed to name the
  cause. (The wording after the package name is the implementer's; the first
  line of the error and the package name are fixed by AC-21.)
- The package is absent: exit 1 and a FATAL that names `node-datachannel`
  (the first line of Node's `Cannot find module` error does).
- No `npm` call is made for node-datachannel: no `rebuild`, no retry, no
  `INSTALL_NATIVE_RETRY_DELAY`, no `sleep`. The registry download that the old
  loop retried is now part of `npm ci`, which the images already run and the
  CI download cache already covers.

Alternatives considered:

- Keep the loop and look for the platform package: the loop retried a download
  that no longer happens in this step; the platform list (nine packages) would
  be a second copy of what npm already selects.
- Check only `package.json` for the optional package: names a file, does not
  show the binary loads on this libc (`--help` shows it only later).

Cost to build: one `node -e` call in the script. Cost to maintain: none while
the package exports `getLibraryVersion`. Undo: revert the commit.

### 2. Dependency

`package.json` and the lockfile move `node-datachannel` 0.32.3 to 0.33.6, both
exact. `werift` stays. The `allowScripts` entry `node-datachannel@0.32.3` stays
because the nested copy under `webrtc-polyfill` is still in the tree.

### 3. Comments

The proxy `Dockerfile` comment, proxy `AGENTS.md` "Gotchas" (it says the script
"builds and checks the two native modules") and
`openspec/changes/archive/2026-11-11-native-build-one-script/design.md` (steps and messages of the
old step 2) are corrected where they describe the rebuild. The add-on
`Dockerfile` comment is a separate pull request.

## Acceptance criteria

- AC-21: step 2 of `scripts/install-native.sh` loads `node-datachannel` from
  the package directory. When the binding loads it logs
  `install-native: node-datachannel <v>: binding loads (libdatachannel <x>)`
  and exits 0 (given the later steps pass). When the require throws it exits
  non-zero with a `FATAL: install-native:` line carrying the first line of the
  error. When the package is absent it exits non-zero with a FATAL that names
  `node-datachannel`. Checked by `test/no-torrent/install-native-script.test.js`.
- AC-22: the script makes no `npm rebuild` call for `node-datachannel`, and
  neither `INSTALL_NATIVE_RETRY_DELAY` nor a retry loop remains in it. The
  `npm rebuild utp-native` of step 6 stays: it is the source build of our fork
  and has no other way to run. Checked by the same file (recorded fake `npm`
  calls).

## Constraints

- Nothing run locally starts a torrent. The load check requires only the
  package's native binding; it opens no peer connection, DHT or tracker. Tests
  never require the real package: the package in the test's temp directory is a
  fake.
- Versions are exact (`AGENTS.md`, "Security" 6).

## Risks

- `getLibraryVersion` missing in a later release: the load check fails with a
  FATAL that names it, which is the signal to adapt the script.
