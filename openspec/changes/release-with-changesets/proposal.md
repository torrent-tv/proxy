# Proposal: Release the proxy with changesets, each commit versioned in place on main

Parent: torrent-tv/meta#336, stage 5 (proxy). The plan is the issue's revision 4
(https://github.com/torrent-tv/meta/issues/336#issuecomment-6765817451) and its
revision 5 amendment (https://github.com/torrent-tv/meta/issues/336#issuecomment-6768238527).
infra, server and ha-addon made the same switch first (torrent-tv/infra#11,
torrent-tv/server#28 and torrent-tv/ha-addon#11, merged); this change reuses their
workflow steps, `scripts/check.sh`, `.node-version`, `packageManager` and
`.changeset/config.json`. It supersedes `release-from-tags`, which is archived in the same
change.

## Problem

The proxy release (`release-from-tags`) plans a version from the newest `v*` tag and
writes it only into the workspace copy of `package.json`: git holds `0.0.0-development`,
a commit never carries its version, and the release notes are changesets in our own
`- **New|Fix|Chore**:` format that CI checks with a shared action (`check-changesets`).
The release, the dependency update and the install into the add-on are shared actions of
`torrent-tv/workflows` (`release-plan`, `release-tag`, `update-dependencies`,
`addon-install-proxy`) whose scripts and tests live outside this repository.

## Why

The owner decided (2026-11-10) that every repository releases from standard changesets:
the version lives in `package.json`, each commit that adds a changeset gets its own version
amended into it on `main`, and no release commit is ever added. Dependency updates come from
Dependabot alerts and run on a schedule, without a pull request. A proxy release reaches
the add-on by starting the add-on's `dependencies.yml` (`workflow_dispatch`, input
`proxy-version`), not by an action that pushes to the add-on.

## What Changes

- `package.json` holds the released version `2.107.80` (the newest tag) instead of
  `0.0.0-development`, names Node 24.22.2 (`.node-version`) and `packageManager`
  `npm@11.19.1`, and pins to the version of its lock entry every specifier that was a
  range: 15 of the 17 `dependencies` and `@biomejs/biome` (`uint8-util`, `webtorrent` and the
  `utp-native` override were exact already). New exact devDependencies: `@changesets/cli` 3.0.3,
  `npm-check-updates` 23.1.1, `semver` 7.8.6. `.npmrc` makes npm save exact versions.
- `.changeset/config.json` (`access: public`) and `.changeset/README.md`. The 17 changeset
  files of `v2.107.65` to `v2.107.80` become entries of `CHANGELOG.md`, which is no longer
  frozen, and are deleted.
- `scripts/check.sh`: `tools`, `pins`, `install`, `guard`, `test`, `image`, `all`. `main.yml`
  runs one function per step, and `dependencies.yml` runs `all` on every commit it prepares.
- `main.yml`: the new first job `version`; `plan` and a matrix of `checks`; `build`;
  `publish` (npm by trusted publishing, tag, GitHub Release, then the add-on's
  `dependencies.yml` is started with the newest version); `rebase-prs`.
  `.github/workflows` calls no action of `torrent-tv/workflows`. Every action is at an exact
  version.
- `dependencies.yml`: alerts and minor updates (WebTorrent and uint8-util held back), tests on
  each prepared commit, push by the release App from a job that runs no package code.
- `audit-exceptions.json` is deleted; its one advisory is dismissed in Dependabot.
- `AGENTS.md` describes the flow; `release-from-tags` is archived.
- The two tests that read `main.yml` (`ci-native-downloads`, `install-native-image`) follow
  the exact cache action version, the script and the job `publish`.

## Capabilities

### New Capabilities

- `release`: how a commit on `main` becomes a version, an npm package, a tag and a GitHub Release.
- `dependency-updates`: how alerts and updates reach `main` without a pull request.
- `addon-install`: how a released proxy reaches the add-on (the dispatch; the add-on's own
  workflow waits for npm and installs it).

### Modified Capabilities

None. Nothing at runtime changes: `server.js` reads the version from `package.json`, which
in the published package is the released one, as before.

## Impact

- The release App `torrent-tv-release` rewrites and force-pushes `main` and starts a
  workflow of ha-addon. Its variable `RELEASE_APP_CLIENT_ID` and secret
  `RELEASE_APP_PRIVATE_KEY` are on the proxy `production` environment.
- The release App has `workflows: write` and `actions: write`.
- npm trusted publishing is unchanged: `torrent-tv/proxy`, workflow `main.yml`, environment
  `production`. The owner has nothing to change on npmjs.com.
- ha-addon has switched already (torrent-tv/ha-addon#11, merged), because the dispatch
  reaches only a workflow that is on its default branch.
- No other proxy pull request may merge between this one and its first release run: the first
  rewrite versions the commit that adds this change's changeset.
