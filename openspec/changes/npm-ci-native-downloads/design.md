# Design: Cache and retry the native downloads of npm ci in CI

Line numbers at proxy `049a88a5`. Package versions from `package-lock.json`:
`node-datachannel` 0.32.3, `prebuild-install` 7.1.3, `ffmpeg-static` 5.3.0,
`@torrent-tv/utp-native` 2.5.3-ttv.9 (optional), npm 11 / node-gyp 12.

## Facts

Observed (run logs, package code, a scratch install):

1. Run 42469344273 (PR #47) failed at `Install dependencies` in attempts 1-3
   (jobs 128696228748, 128696439056, 128697404126) and passed in attempts 4-8.
   - Attempts 1 and 3: `ffmpeg-static` `node install.js` → `Failed to download
     ffmpeg b6.1.1`, `url:
     'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz'`,
     `statusCode: 504`.
   - Attempt 2: `node-datachannel` `prebuild-install -r napi` → `No prebuilt
     binaries found (target=8 runtime=napi arch=x64 libc= platform=linux)`,
     then the source fallback `prebuild -r napi --backend cmake-js` →
     `prebuild ERR! build TypeError: expected first argument to be an array`,
     `npm error code 2`.
2. `prebuild-install` reports ANY non-200 answer as "No prebuilt binaries
   found" (`download.js:56` → `onerror()` without an error), makes one request
   with no retry, and keeps the downloaded tarball in
   `$npm_config_cache/_prebuilds` (`util.js:84-88`); npm sets
   `npm_config_cache` to `/home/runner/.npm` on the runner (setup-node log). A
   tarball already there is used without any request (`download.js:35-38`).
   The URL is `https://github.com/murat-dogan/node-datachannel/releases/download/v0.32.3/node-datachannel-v0.32.3-napi-v8-linux-x64.tar.gz`
   (`util.js:43,60`; N-API 8, so it does not depend on the node version).
   The source fallback is broken (Fact 1), so this download is required.
3. `ffmpeg-static` 5.3.0: the binary path is `$FFMPEG_BIN`, else
   `node_modules/ffmpeg-static/ffmpeg` (`index.js`, `binary-path-env-var`).
   `install.js:38-43` exits 0 with `ffmpeg is installed already.` when that path
   is a file, before any request. Otherwise it downloads
   `ffmpeg-linux-x64.gz`, `linux-x64.README` and `linux-x64.LICENSE` from
   `${FFMPEG_BINARIES_URL:-https://github.com/eugeneware/ffmpeg-static/releases/download}/${FFMPEG_BINARY_RELEASE:-b6.1.1}/`.
   Its retry is `@derhuerst/http-basic`'s default: 5 retries 200 ms apart
   (`lib/index.js:290-305`), about one second in all. Its HTTP file cache
   (`~/.cache/ffmpeg-static-nodejs`, `env-paths` adds `-nodejs`) never avoids
   the request: GitHub's 302 is not stored, and the signed redirect URL is new
   each time (a scratch `npm ci` on 2026-11-09 downloaded again and added new
   entries next to 20 old ones). `npm ci` empties `node_modules` first, so
   every CI run downloads ffmpeg.
4. `@torrent-tv/utp-native` has no `prebuilds/`, so `node-gyp-build` compiles
   it on every install (the attempt-1 log ends with `Terminate orphan process
   ... (node-gyp)`). node-gyp uses headers in `~/.cache/node-gyp/<version>`
   (`bin/node-gyp.js:25`, `env-paths('node-gyp', {suffix: ''})`) and downloads
   `node-v<version>-headers.tar.gz` from nodejs.org when they are missing; it
   uses the running node's own headers only when node was built with
   `use_prefix_to_find_headers` (`lib/configure.js:34-53`), which official
   builds are not. These headers are per node version.
5. `actions/setup-node` with `cache: npm` restores and saves the whole npm cache
   directory (`/home/runner/.npm`, so `_prebuilds` included) under
   `node-cache-Linux-x64-npm-<hash>` (green job 129090731382: `Cache restored
   from key: node-cache-Linux-x64-npm-51001ec8…`). Its post step saves only when
   the key missed and the whole job succeeded. It does not hold ffmpeg or the
   node headers, and its key has no node version.
6. `package.json` `allowScripts` lists the 11 packages whose install scripts
   npm may run (ffmpeg-static, node-datachannel, utp-native, bufferutil,
   utf-8-validate, the `@ffprobe-installer/*` platform packages); `ip-set` is
   refused. `bufferutil` and `utf-8-validate` ship prebuilds; the
   `@ffprobe-installer/*` packages only `chmod` a binary that comes inside the
   npm package. None of this changes.
7. Scratch `npm ci --foreground-scripts` on macOS (node 24.22.2, npm 11.19.1,
   darwin-arm64, not the Linux runner): 302 packages in 8 s; output comes from
   bufferutil, ffmpeg-static (silent when it downloads), node-datachannel
   (silent at the default log level), utf-8-validate, utp-native (node-gyp:
   about 45 lines), `@ffprobe-installer/darwin-arm64` (`chmod u+x ffprobe`).
8. `Dockerfile:31-36` installs with `--ignore-scripts` and retries
   `npm rebuild node-datachannel` five times, 10 s apart. It is not touched.

Estimates (to confirm on the first CI run):

- On the runner node-gyp downloads the headers (Fact 4), since no cache holds
  `~/.cache/node-gyp`; the first run's log shows `gyp http GET
  https://nodejs.org/...` once `--foreground-scripts` is on.
- The cache entry is about 150 MB before compression (ffmpeg ~77 MB, headers
  ~64 MB on macOS, prebuild a few MB). The daily dependency update changes the
  lockfile, so one new entry a day; GitHub evicts entries unused for 7 days.

## Decisions

1. **One cache for everything `npm ci` downloads outside the registry**:
   `~/.npm/_prebuilds`, `~/.cache/node-gyp`, `~/.cache/torrent-tv/ffmpeg-static`.
   `_prebuilds` is also inside setup-node's cache (Fact 5), but that one is saved
   only after the whole job succeeds; keeping it here costs a few MB and makes
   the new cache complete on its own. No separate cache per package.
2. **Key** `native-downloads-${{ runner.os }}-${{ runner.arch }}-node-${{ steps.node.outputs.node-version }}-${{ hashFiles('package-lock.json') }}`.
   The node version is there for the node-gyp headers (Fact 4); the lockfile
   hash pins the ffmpeg-static and node-datachannel versions. **No
   `restore-keys`**: the ffmpeg file name carries no version, so a partial match
   could restore an older ffmpeg.
3. **ffmpeg through `FFMPEG_BIN`** (Fact 3): `npm ci` empties `node_modules`
   before the install script runs, so nothing placed there survives. On a hit
   the step exports `FFMPEG_BIN=$HOME/.cache/torrent-tv/ffmpeg-static/ffmpeg`;
   `install.js` finds the file and makes no request; after `npm ci` the step
   copies it to `node_modules/ffmpeg-static/ffmpeg`, where the tests'
   `import ffmpegBin from "ffmpeg-static"` look (`FFMPEG_BIN` is set for the
   install step only). On a miss `FFMPEG_BIN` stays unset, ffmpeg-static
   downloads into `node_modules` as today, and the step copies the finished
   binary into the cache directory. A download that breaks off therefore never
   leaves a partial file in the cache: `node_modules` is emptied by the next
   attempt.
4. **Restore before, save right after a successful install**, as the packet
   timing cache does (`main.yml:52-80`). The save step has
   `if: steps.native-downloads.outputs.cache-hit != 'true'`, which keeps the
   default `success()`; a failed install saves nothing.
5. **Retry the whole `npm ci`**, 3 attempts, 20 s apart (the issue asks for one
   or two retries; the Dockerfile waits 10 s). A later attempt reuses what an
   earlier one fetched: the npm cache, `_prebuilds`. Whatever fails, npm ci
   fails the step after the third attempt as today, so nothing is weakened.
6. **The retry is a script, `scripts/retry.mjs`**, so that a test can prove it
   with a fake failing command (AC 2), which an inline shell loop cannot. It
   knows nothing about npm. Each failed attempt but the last prints
   `::warning::<command> failed on attempt <n> of <N> (exit <code>); retrying in
   <d> s` to stderr, so a retry is visible in the run summary.
7. **`npm ci --foreground-scripts`**: the install scripts' output goes into the
   log (about 50 lines, mostly the utp-native compile, Fact 7). This is how AC 1
   is read: `ffmpeg is installed already.` on a hit, `gyp http GET` on a miss.
   prebuild-install stays silent at npm's default log level; on a hit its
   tarball is in the restored `_prebuilds` and Fact 2 says it then makes no
   request.
8. **The shared actions do not change**: the install step is this repository's
   own; `torrent-tv/.github` has no install action.

## `scripts/retry.mjs`

```
node scripts/retry.mjs <attempts> <delay-seconds> <command> [args...]
```

- `attempts`: integer ≥ 1; `delay-seconds`: number ≥ 0. Anything else, or no
  command: usage message on stderr, exit 2, the command never runs.
- Runs the command with `spawnSync(command, args, { stdio: "inherit" })` (no
  shell), environment inherited.
- Exit 0 → exit 0 at once. Non-zero exit (or a signal, counted as 1) → if
  attempts remain, print the warning (Decision 6), wait `delay-seconds`, run
  again; after the last attempt exit with its code.
- A spawn error (command not found) → print it, exit 127, no retry.
- About 30 lines, no dependencies, ES module like the other `scripts/*.mjs`.

## The `checks` job

```yaml
      - uses: actions/setup-node@v7
        id: node
        with:
          node-version: 24
          cache: npm
```

and, replacing `main.yml:87-88`:

```yaml
      # npm ci fetches three things outside the npm registry, with no retry of its
      # own worth the name: node-datachannel's binary and ffmpeg-static's ffmpeg
      # from GitHub releases, and node's headers from nodejs.org to compile
      # utp-native. A GitHub 504 failed every pull request on 2026-11-08
      # (torrent-tv/meta#338). With an unchanged lockfile they come from here.
      - name: Restore native download cache
        id: native-downloads
        uses: actions/cache/restore@v6
        with:
          path: |
            ~/.npm/_prebuilds
            ~/.cache/node-gyp
            ~/.cache/torrent-tv/ffmpeg-static
          key: native-downloads-${{ runner.os }}-${{ runner.arch }}-node-${{ steps.node.outputs.node-version }}-${{ hashFiles('package-lock.json') }}
      # ffmpeg-static skips its download when FFMPEG_BIN names a file. npm ci
      # empties node_modules first, so the cached ffmpeg is copied in afterwards,
      # and a freshly downloaded one is copied out for the cache.
      - name: Install dependencies
        env:
          CACHE_HIT: ${{ steps.native-downloads.outputs.cache-hit }}
        run: |
          echo "::notice::Native download cache: ${CACHE_HIT:-miss}"
          ffmpeg_cache="$HOME/.cache/torrent-tv/ffmpeg-static/ffmpeg"
          if [ -f "$ffmpeg_cache" ]; then export FFMPEG_BIN="$ffmpeg_cache"; fi
          node scripts/retry.mjs 3 20 npm ci --foreground-scripts
          if [ -n "${FFMPEG_BIN:-}" ]; then
            cp "$FFMPEG_BIN" node_modules/ffmpeg-static/ffmpeg
          else
            mkdir -p "$(dirname "$ffmpeg_cache")"
            cp node_modules/ffmpeg-static/ffmpeg "$ffmpeg_cache"
          fi
      - name: Save native download cache
        if: steps.native-downloads.outputs.cache-hit != 'true'
        uses: actions/cache/save@v6
        with:
          path: |
            ~/.npm/_prebuilds
            ~/.cache/node-gyp
            ~/.cache/torrent-tv/ffmpeg-static
          key: native-downloads-${{ runner.os }}-${{ runner.arch }}-node-${{ steps.node.outputs.node-version }}-${{ hashFiles('package-lock.json') }}
```

The `path` blocks and `key` lines of restore and save are identical text.

## Tests (first commit, fail before the change)

`test/no-torrent/retry-command.test.js` runs `node scripts/retry.mjs` with
`spawnSync(process.execPath, ["scripts/retry.mjs", ...])` from the repository
root; the command is `process.execPath -e <script>` that appends a line to a
counter file in a fresh temp directory and exits with a code chosen by the
count:

1. fails on run 1, exits 0 on run 2; attempts 3, delay 0 → status 0, counter 2,
   stderr matches `/failed on attempt 1 of 3/`;
2. always exits 7; attempts 3, delay 0 → status 7, counter 3, stderr matches
   `/failed on attempt 2 of 3/` and does not match `/attempt 3 of 3.*retrying/`;
3. exits 0 at once; attempts 3, delay 0 → status 0, counter 1, no `failed` in
   stderr;
4. fails on run 1, exits 0 on run 2; attempts 2, delay 1 → status 0 and the
   whole call took at least 1000 ms;
5. attempts `0` → status 2, counter 0 (the command never ran).

Before the change `scripts/retry.mjs` does not exist: node exits 1 and the
counter stays 0, so checks 1-4 fail on the counter or status (no retry exists),
not on an import inside the test.

`test/no-torrent/ci-native-downloads.test.js` reads
`.github/workflows/main.yml` as text (no YAML dependency): takes the `checks`
job (from `  checks:` to `  build:`), splits it into steps at lines starting
with `      - `, and finds steps by `name:` (setup-node by `uses:
actions/setup-node@`). It checks:

1. the setup-node step has `id: node`;
2. a step `Restore native download cache` uses `actions/cache/restore@v6`; its
   `path` lists `~/.npm/_prebuilds`, `~/.cache/node-gyp` and
   `~/.cache/torrent-tv/ffmpeg-static`; its `key` contains `runner.os`,
   `runner.arch`, `steps.node.outputs.node-version` and
   `hashFiles('package-lock.json')`; it has no `restore-keys`;
3. a step `Save native download cache` uses `actions/cache/save@v6` with the
   same `path` block and `key` line as the restore step (string-equal); it has
   no `continue-on-error`, and its `if`, if any, has no `always()`,
   `failure()` or `cancelled()`;
4. order: restore before `Install dependencies`, which is before save, which is
   before `Lint and tests`;
5. `Install dependencies`: its `run` calls `node scripts/retry.mjs <a> <d> npm
   ci` with `a` ≥ 2 and `d` ≥ 10, sets `FFMPEG_BIN`, and names
   `node_modules/ffmpeg-static/ffmpeg`; it has no `--ignore-scripts`, no
   `|| true` and no `continue-on-error`.

Before the change the workflow has none of these steps, so checks 1-5 fail on
the missing step or field.
