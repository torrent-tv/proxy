## Why

torrent-tv/meta#336, stage 9. Moving the proxy from `node-datachannel` 0.32.3 to
0.33.6 breaks `scripts/install-native.sh`: every image that installs the proxy
stops at step 2 with `FATAL: install-native: node-datachannel has no native
binary; the proxy would have no WebRTC`, although the binding loads.

Measured (CI probe run 42927294266, Alpine 3.24.4, npm 11.12.1, x86_64 and
aarch64; with 0.33.6 `require` works, a loopback data channel carries a
message, libdatachannel is 0.24.6, `--help` exits 0):

- 0.33.x has no install script and no `prebuild-install`. Its binary comes as
  optional npm packages, one per platform (`@node-datachannel/linux-x64-musl`,
  `@node-datachannel/linux-arm64-musl` and seven more, each with `libc: musl`
  where it applies). `npm ci --ignore-scripts` installs the one that fits.
- Step 2 still assumes 0.32.3: it runs `npm rebuild node-datachannel` and then
  looks for `node_modules/node-datachannel/build/Release/*.node`, a path 0.33.x
  never writes. The rebuild does nothing for 0.33.x; it only rebuilt the nested
  0.32.3 copy that `webrtc-polyfill` pulls, which nothing loads because the
  worker redirects `webrtc-polyfill` to werift.

The viewer-facing effect of leaving it: the add-on image does not build, so no
proxy update reaches Home Assistant.

## What Changes

- `package.json` and `package-lock.json`: `node-datachannel` 0.32.3 to 0.33.6.
  `werift` stays. The `allowScripts` entry for `node-datachannel@0.32.3` stays
  for the nested copy.
- `scripts/install-native.sh` step 2: the rebuild loop and
  `INSTALL_NATIVE_RETRY_DELAY` are removed; a load check takes their place.
- Comments that describe the old behaviour are corrected: proxy `Dockerfile`,
  proxy `AGENTS.md` "Gotchas", and the superseded
  `openspec/changes/archive/2026-11-11-native-build-one-script/design.md`.
- The add-on `Dockerfile` comment is a separate pull request in `ha-addon`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `native-build`: the node-datachannel step checks that the binding loads
  instead of rebuilding it.

## Impact

- proxy: `package.json`, `package-lock.json`, `scripts/install-native.sh`,
  `Dockerfile` (comments), `AGENTS.md`, `openspec/changes/archive/2026-11-11-native-build-one-script/design.md`,
  `test/no-torrent/install-native-script.test.js`, `.changeset/`.
- ha-addon: `torrent_tv_proxy/Dockerfile` comment, separate pull request.
