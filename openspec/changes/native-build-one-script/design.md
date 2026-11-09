## Context

Issue: torrent-tv/meta#302. Lines below are at proxy `2b58e9b`, ha-addon
`4172553`; re-locate by name.

- `proxy/Dockerfile`, stage `dependencies`: `npm ci --omit=dev
  --ignore-scripts`, then a 5-attempt `npm rebuild node-datachannel` loop
  (message `node-datachannel: build attempt $attempt failed`), an `ls` of its
  binary, a best-effort `npm_config_build_from_source=true npm rebuild
  utp-native` and removal of `obj.target` / `.deps` of `utp-native` only.
- `ha-addon/torrent_tv_proxy/Dockerfile`, stage `build`: a Node >= 24 check,
  `npm install --global @torrent-tv/proxy@${PROXY_VERSION} --ignore-scripts`,
  the same retry loop with `--global`, a check that the proxy's
  `overrides['utp-native']` is `npm:@torrent-tv/utp-native@*`, a `--no-save`
  install of that spec inside the package (a global install ignores
  `overrides`), removal of nested `utp-native` copies, the best-effort source
  build, a check that every `utp_native.node` belongs to
  `@torrent-tv/utp-native`, and removal of `obj.target` / `.deps` everywhere.
- `ha-addon/torrent_tv_proxy/run.sh`: the block ending in
  `export UV_THREADPOOL_SIZE=64` (comment and export).
- `proxy/bin/thread-pool.js`: sets `UV_THREADPOOL_SIZE=64` when unset.

## Goals / Non-Goals

Goals: one build of the native modules, with the add-on's checks, used by
both images; one smoke test per image, inside its Dockerfile's final stage;
a CI `build` job in proxy and server that the release needs.

Non-goals (out of scope): `poisonmalloc` and `tcpdump` (add-on only);
publishing a proxy image; the add-on workflow (`ha-addon/.github/workflows/
main.yml` already has `build: Image builds`, needed by its release; another
task owns that file now); any change of the `utp-native` fork itself.

## Decisions

### 1. `scripts/install-native.sh <package dir>`

POSIX `sh` (Alpine BusyBox `ash` runs it; also macOS/Ubuntu `sh` for tests),
`set -eu`, LF line endings, executable bit set in git. Every `npm` and `node`
call is resolved through `PATH` (no absolute paths), and every `npm` call runs
with the package directory as its working directory, without `--global`. The
script never downloads anything except through `npm`.

Argument: the directory holding the installed proxy (`package.json` and
`node_modules/`). Missing argument, or no `package.json` in it: usage on
stderr, exit 2.

Environment: `INSTALL_NATIVE_RETRY_DELAY` — seconds between
`node-datachannel` attempts, default `10`. Nothing else is configurable.

Steps, in this order; any `FATAL` line goes to stderr and exits 1:

1. **Node floor.** The floor is read from the package's
   `engines.node`, which must have the form `>=N` (N an integer); any other
   form is `FATAL: install-native: engines.node must be ">=N", found <value>`.
   The running major is `node -p 'process.versions.node'` split at the first
   dot. Below the floor: `FATAL: install-native: this proxy requires Node N or
   newer; found v<version>`. Otherwise prints
   `install-native: node v<version> (floor N)`.
2. **node-datachannel.** Up to 5 attempts of `npm rebuild node-datachannel`;
   after each failed attempt but the last, prints to stderr
   `install-native: node-datachannel attempt <k> of 5 failed; retrying in <d>s`
   and sleeps `<d>` = `INSTALL_NATIVE_RETRY_DELAY`. Stops at the first
   success. Then at least one file must match
   `node_modules/node-datachannel/build/Release/*.node`, else
   `FATAL: install-native: node-datachannel has no native binary; the proxy
   would have no WebRTC` (also when all 5 attempts failed).
3. **utp-native spec.** `overrides['utp-native']` of the package's
   `package.json` must start with `npm:@torrent-tv/utp-native@`, else
   `FATAL: install-native: the proxy pins no utp-native build of ours: <value>`
   (`<value>` is `undefined` when absent). Prints
   `utp-native: the proxy pins <spec>`.
4. **Ours at the top.** When `node_modules/utp-native/package.json` is
   missing or its `name` is not `@torrent-tv/utp-native`, runs
   `npm install --omit=dev --ignore-scripts --no-save --no-audit --no-fund
   "utp-native@<spec>"`. (After `npm ci` with `overrides` it is already ours
   and nothing is installed.)
5. **Nested copies removed.** Every directory named `utp-native` under
   `node_modules/` other than `node_modules/utp-native` itself (that is, at
   depth 3 or more counting `node_modules` as depth 0, e.g.
   `node_modules/webtorrent/node_modules/utp-native`) is removed.
6. **Source build, best effort.** `npm_config_build_from_source=true npm
   rebuild utp-native`. On failure prints to stderr
   `WARNING: utp-native build failed; peer connections stay TCP-only` and
   continues (exit status unaffected).
7. **Provenance.** For every file `node_modules/**/build/Release/utp_native.node`
   (paths through `obj.target` excluded), the `package.json` three directories
   above the file (the package root) must have `"name":
   "@torrent-tv/utp-native"`, else `FATAL: install-native: <path> is not our
   build`. Each one that is ours prints `utp-native: our build at <path>`.
   This is the provenance line AC-6 reads in the add-on update log.
8. **Clean-up.** Every `obj.target` and `.deps` directory directly under a
   `build/Release/` directory anywhere under `node_modules/` is removed.

Exit 0.

Why the script reads the floor from `engines.node`: the package already states
it there, so it is said once. Why `npm` without `--global` in the add-on's
global layout: the installed proxy is a directory with its own `package.json`
and `node_modules/`, and `npm rebuild` / `npm install --no-save` run there act
on that tree, as the add-on's own `npm install --no-save` already does today.
The add-on CI build job proves it before the add-on releases.

### 2. Shipped in the package

`package.json` `files` gains exactly `"scripts/install-native.sh"` (not the
whole `scripts/` folder). `npm pack --dry-run` then lists that one file more
than before and nothing else new.

### 3. `proxy/Dockerfile`

Stage `dependencies`:

```
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY scripts/install-native.sh scripts/install-native.sh
RUN sh scripts/install-native.sh /app
```

with the existing comment about `--ignore-scripts` kept and the comments about
the retry and `utp-native` replaced by one line pointing at the script. No
`node-datachannel: build attempt` string remains in the Dockerfile.

Final stage, after `USER app` and `WORKDIR /app`:

```
RUN node /app/bin/cli.js --help > /dev/null
```

`--help` loads every module of the main thread, `node-datachannel`'s native
binding included, and commander exits before anything is started or
connected (no torrent, no network), so the build fails when the runtime node
cannot load what the first stage built.

### 4. Proxy CI

`.github/workflows/main.yml` job `build` (`Image build`, needs `checks`) keeps
only `docker build`; the step `Start the proxy in it` is removed, since the
build now runs the same check. `release` keeps `needs: [checks, build]`.
A pull request whose Dockerfile is broken fails `Image build`.

### 5. Add-on (second pull request, after the proxy release)

Only after a proxy version carrying the script is on npm and `PROXY_VERSION`
points at it (the release bot pushes that pin):

- `torrent_tv_proxy/Dockerfile`, stage `build`: the Node-floor `RUN` is
  removed; the install `RUN` becomes the `echo` of versions, the global
  install, then
  `sh /usr/local/lib/node_modules/@torrent-tv/proxy/scripts/install-native.sh /usr/local/lib/node_modules/@torrent-tv/proxy`.
  The long comments that describe what the script now does are reduced to a
  pointer to the script; the comments on `BUILD_VERSION`, `PROXY_VERSION`
  and `ip-set` stay. `poisonmalloc`, the final stage and its `--help` stay.
- `torrent_tv_proxy/run.sh`: the `UV_THREADPOOL_SIZE` comment block and
  `export UV_THREADPOOL_SIZE=64` are removed; the proxy's
  `bin/thread-pool.js` default applies.
- `torrent_tv_proxy/CHANGELOG.md`: an entry under `## Unreleased`.

### 6. Server

See `server/openspec/changes/image-smoke-check/`.

## Acceptance criteria

- AC-1: `grep -c "node-datachannel: build attempt"` prints 0 for
  `proxy/Dockerfile` and `ha-addon/torrent_tv_proxy/Dockerfile`. Checked by a
  static test in the proxy for its Dockerfile, and by `grep` on add-on `main`
  after the second PR.
- AC-2: `scripts/install-native.sh` behaves as in Decision 1 (steps 1–8,
  usage, exit codes, messages). Checked by proxy tests running the script
  against a temporary package directory with fake `npm` / `node` on `PATH`.
- AC-3: the script is in the npm package and is the only new file there; it
  is LF and executable. Checked by a proxy test (`npm pack --dry-run --json`
  or `files`), and by CI's `check-line-endings`.
- AC-4: the proxy Dockerfile runs `install-native.sh` after `npm ci` and
  `--help` in its final stage; the CI `build` job builds the image and the
  release needs it; a deliberately broken Dockerfile fails `Image build` on a
  pull request. Checked by a static test of the Dockerfile and the workflow,
  then once on GitHub with a throwaway pull request that is closed after.
- AC-5: the `build` jobs of proxy, server and ha-addon are green on the merged
  heads.
- AC-6: after the add-on update on Home Assistant, the update (build) log
  shows `utp-native: our build at …` and the proxy starts (add-on state
  `started`, `/healthz` OK). Checked on the HA host by the coordinator.
- AC-7: `ha-addon/torrent_tv_proxy/run.sh` sets no `UV_THREADPOOL_SIZE`.
  Checked by `grep` on add-on `main`.

## Constraints

- Order: proxy release with the script first, then the add-on Dockerfile.
- The script is LF and is the only new file in the npm package.
- Nothing run locally may start a torrent; `--help` in a local `docker build`
  is allowed (it exits during argument parsing). Tests never run the real
  `npm rebuild` or touch the network: `npm` is a fake on `PATH`.

## Risks

- `npm rebuild` without `--global` inside the global layout: proven by the
  add-on CI build before the add-on releases; if it fails there, the script is
  fixed in a proxy patch before the add-on change merges.
