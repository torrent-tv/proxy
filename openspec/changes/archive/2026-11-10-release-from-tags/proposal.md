# Proposal: Release the proxy from tags and changesets

Parent: torrent-tv/meta#336, step 2 (proxy). Step 1 (the actions
`check-changesets`, `release-plan`, `release-tag` and the `changeset` input of
`update-dependencies`) is merged in `torrent-tv/workflows` (`bc381ae`).

## Problem

Every proxy release commits `chore(release): <version>` straight to `main`
(`release-prepare` + `release-finish`, `.github/workflows/main.yml:138-161`),
and every pull request edits the one shared `## Unreleased` section of
`CHANGELOG.md` (`check-changelog`, `main.yml:84-88`). Three of about 12 merged
proxy pull requests existed only to fix that section after a release moved it
(proxy#40, #44, the rebase of #45), and `main` was red for about 10 minutes
because of it (run 42366813691).

## Why

The release state is written back into `main`, and the pending notes are one
shared text. With a changeset file per pull request and the version taken from
the newest `v*` tag, a release writes nothing to `main` and two pull requests
never touch the same notes.

## What Changes

- `main.yml` checks: `check-changelog` is replaced by `check-changesets`.
- `main.yml` release: `release-plan` → `npm publish` (skipped when npm already
  holds the version from this very commit) → `release-tag`. No commit, no
  branch push. The add-on steps (`addon-install-proxy`) stay and read the same
  outputs (`version`, `bump`, `notes-file`) from `release-plan`.
- `dependencies.yml`: `changeset: "true"`, so the daily update writes
  `.changeset/deps-<run>-<attempt>.md` instead of a changelog entry.
- `package.json` and `package-lock.json` (both fields) hold `0.0.0-development`;
  the release writes the real version into the build workspace only, so the
  published package and the npm version state it.
- `CHANGELOG.md` is frozen: one line at the top points to
  https://github.com/torrent-tv/proxy/releases.
- `.githooks/pre-push`, whose only rule is the `## Unreleased` entry, is removed.
- `AGENTS.md` "Changelog" becomes "Changesets" (the file format) and "Release"
  describes the new order; `openspec/config.yaml` context drops the changelog
  rule.
- The pull request adds its own changeset,
  `.changeset/ci-ttv-336-release-from-tags.md`.

## Capabilities

### New Capabilities

None. Release tooling is not a capability covered by `openspec/specs/`.

### Modified Capabilities

None. Runtime behaviour does not change: `server.js:90` and `bin/cli.js:45`
read the version from `package.json`, which in the published package is the
released one.

## Impact

CI files, `package.json`/`package-lock.json` version fields, `CHANGELOG.md`
head, `.githooks/pre-push`, `AGENTS.md`, `openspec/config.yaml`. No source or
test under `services/`, `routes/`, `bin/`, `utils/`, `test/` changes.

## Non-goals

- The add-on dispatch (`repository_dispatch` to `torrent-tv/ha-addon`, release
  branch): step 3. Until then `addon-install-proxy` commits
  `fix|feat(proxy): install proxy X` to ha-addon `main` as today.
- Removing `release-prepare`, `release-finish`, `check-changelog`,
  `addon-install-proxy` and their scripts from `torrent-tv/workflows`: step 4.
- The server's switch: its own step-2 pull request.
- Rewriting the history in `CHANGELOG.md`.
