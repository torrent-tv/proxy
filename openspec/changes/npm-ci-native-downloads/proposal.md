# Proposal: Cache and retry the native downloads of npm ci in CI

Issue: torrent-tv/meta#338. Branch `ci/ttv-338-npm-ci-cache-retry`.

## Problem

The `Install dependencies` step of the `checks` job (`npm ci`,
`.github/workflows/main.yml:87-88`) makes three anonymous downloads outside the
npm registry, with no cache across runs and no useful retry:

- `node-datachannel@0.32.3` fetches its prebuilt binary from GitHub releases
  (`prebuild-install`, one request);
- `ffmpeg-static@5.3.0` fetches `ffmpeg-linux-x64.gz` from GitHub releases into
  `node_modules`, which `npm ci` empties on every run;
- `@torrent-tv/utp-native` ships no prebuilds, so `node-gyp` compiles it and
  needs the node headers from nodejs.org.

On 2026-11-08 GitHub answered `504` for release downloads. Proxy run
42469344273 (PR #47) failed three times running at this step: twice on the
ffmpeg download, once on the node-datachannel download. Every pull request is
blocked while that lasts, whatever it changes.

## Why

A pull request must pass or fail on its own change. A CI that fails on a short
GitHub outage stops all proxy work, including fixes viewers wait for, and costs
manual re-runs (that run needed eight attempts).

## What Changes

- `scripts/retry.mjs` (new): `node scripts/retry.mjs <attempts> <delay-seconds>
  <command> [args...]` runs the command until it exits 0, at most `attempts`
  times, waiting `delay-seconds` between attempts, and exits with the last
  attempt's code.
- `.github/workflows/main.yml`, `checks` job:
  - `actions/setup-node` gets `id: node` (its `node-version` output goes into the
    cache key);
  - a new step `Restore native download cache` (`actions/cache/restore@v6`)
    before `Install dependencies`, paths `~/.npm/_prebuilds`, `~/.cache/node-gyp`,
    `~/.cache/torrent-tv/ffmpeg-static`, key
    `native-downloads-<OS>-<arch>-node-<node version>-<hash of package-lock.json>`,
    no `restore-keys`;
  - `Install dependencies` runs `npm ci --foreground-scripts` through
    `scripts/retry.mjs` (3 attempts, 20 s apart), points ffmpeg-static at the
    cached ffmpeg (`FFMPEG_BIN`) when the cache holds one, and copies the binary
    between the cache directory and `node_modules/ffmpeg-static/ffmpeg`;
  - a new step `Save native download cache` (`actions/cache/save@v6`) right after
    it, only when the restore missed and the install succeeded.
- Tests (written first, own commit): `test/no-torrent/retry-command.test.js` and
  `test/no-torrent/ci-native-downloads.test.js`.
- `.changeset/ci-ttv-338-npm-ci-cache-retry.md`.

## Capabilities

### New Capabilities

None. CI tooling is not a capability covered by `openspec/specs/`.

### Modified Capabilities

None. No runtime code changes.

## Impact

`.github/workflows/main.yml` (`checks` job only), `scripts/retry.mjs`, two
tests, one changeset. Nothing under `services/`, `routes/`, `bin/`, `utils/`
changes; `Dockerfile`, `package.json` (`allowScripts` included) and
`package-lock.json` do not change.

## Acceptance criteria (issue #338)

1. A CI run with a new cache key (miss) and a second run with the same lockfile
   (hit) both pass; the second run's log shows `Native download cache: true`,
   `ffmpeg is installed already.`, no `gyp http GET`, and the save step skipped.
   Checked by reading both run logs; both run ids recorded on the issue.
2. The retry is shown by `test/no-torrent/retry-command.test.js`: a command that
   fails on its first attempt and succeeds on its second makes the helper exit 0
   after exactly two runs; a command that always fails runs exactly `attempts`
   times and its exit code is returned.
3. `git diff origin/main -- Dockerfile` is empty.
4. CI of `torrent-tv/proxy` is green on the pull request.

## Non-goals

- Replacing `node-datachannel`, `ffmpeg-static` or `utp-native`.
- The `Dockerfile` and the `Image build` job (they install with
  `--ignore-scripts` and already retry node-datachannel).
- `.github/workflows/dependencies.yml` and the shared `update-dependencies`
  action, which install too; a separate issue if they fail the same way.
- The shared actions in `torrent-tv/.github` (`check-workflows` is meta#337).
- Mirroring the binaries elsewhere (`FFMPEG_BINARIES_URL`,
  `npm_config_node_datachannel_binary_host`).
