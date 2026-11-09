## Why

torrent-tv/meta#302 (sub-issue 16.22 of #279, "Solve each recurring task one
way").

The proxy's two native modules — `node-datachannel` (the WebRTC transport) and
`utp-native` (our fork, uTP to peers) — are built by two different scripts:

- `proxy/Dockerfile` installs from the lockfile and rebuilds both, with no
  Node floor check and no check that the `utp-native` it built is ours.
- `ha-addon/torrent_tv_proxy/Dockerfile` installs the package globally (which
  ignores `overrides`), checks Node >= 24, refuses a foreign `utp-native`,
  removes nested copies and cleans every build directory.

A fix made in one is missing from the other. The add-on's checks exist
because each one cost a field failure (a nested broken `utp-native` killed the
process on 2026-08-19; a single failed binary download ended a build on
2026-08-12). The viewer-facing effect of a drift is a proxy that starts
without WebRTC (no film at all) or crashes after hours with the unfixed
`utp-native`.

Also, `ha-addon/torrent_tv_proxy/run.sh` exports `UV_THREADPOOL_SIZE=64`,
which `proxy/bin/thread-pool.js` already sets when the variable is absent: a
later change of the proxy default would be silently pinned on Home Assistant.

"The image builds and starts" is checked three different ways: the proxy in a
CI step after the build, the add-on inside its Dockerfile, the server not at
all before its release job pushes the image.

## What Changes

- New `proxy/scripts/install-native.sh <package dir>`: the one build of the
  native modules, shipped in the npm package (`files`), used by
  `proxy/Dockerfile` after `npm ci` and, after this proxy is released, by the
  add-on Dockerfile after its global install.
- `proxy/Dockerfile` runs the smoke test (`--help`) in its final stage; the CI
  `build` job only builds the image (its separate `docker run --help` step is
  removed, since the build now fails by itself).
- Server (`server/openspec/changes/image-smoke-check/`): a smoke check in the
  final stage of its Dockerfile that loads the whole server without listening,
  and a `build` job in its checks that the release job needs.
- Add-on (second step, after the proxy release that ships the script): the
  Dockerfile runs the installed script; `run.sh` no longer sets
  `UV_THREADPOOL_SIZE`.

## Capabilities

### New Capabilities

- `native-build`: one script builds and checks the proxy's native modules
  for every image that installs the proxy.

### Modified Capabilities

None.

## Impact

- proxy: `scripts/install-native.sh` (new), `package.json` (`files`),
  `Dockerfile`, `.github/workflows/main.yml` (build job), `.changeset/`.
- server: `server.js`, `Dockerfile`, `.github/workflows/main.yml`,
  `CHANGELOG.md` — see its own change.
- ha-addon: `torrent_tv_proxy/Dockerfile`, `torrent_tv_proxy/run.sh`,
  `torrent_tv_proxy/CHANGELOG.md`. Its workflow already has an `Image builds`
  job that the release needs; it is not changed here.
