# Tasks: Release the proxy with changesets

Parent: torrent-tv/meta#336, stage 5 (proxy). Branch `ci/ttv-336-release-with-changesets`.
No new `node:test` applies: no code under test changes, only workflow YAML, `package.json`,
shell steps and `scripts/check.sh`; `ci-native-downloads.test.js` and `install-native-image.test.js`
follow the exact action version, the script and the renamed job. The first commit (`test(store)`)
fixes the checks that hung the test command (design.md, Fact 11): it writes into an output's
directory only after the store's watch reports. The checks are the Checks run of
this pull request, scratch repositories (design.md, Facts 2 and 3) and the first runs on `main`.
`[x]` is done and shown; `[ ]` waits for the merge. No other proxy pull request merges between this
one and its first release run.

## 1. Files

- [x] 1.1 `package.json` (`2.107.80`, `packageManager`, exact pins, three exact devDependencies),
      `package-lock.json`, `.npmrc`, `.node-version`, `.changeset/config.json`,
      `.changeset/README.md`.
- [x] 1.2 `CHANGELOG.md` holds the 17 released changesets as the entries `changeset version`
      writes; the 17 files are deleted.
- [x] 1.3 `scripts/check.sh` with `tools`, `pins`, `install`, `guard`, `test`, `image`, `all`;
      `main.yml` calls one function per step; every action at an exact version.
- [x] 1.4 `main.yml`: `version`, `plan`, matrix `checks`, `build`, `publish`, `rebase-prs`.
- [x] 1.5 `dependencies.yml`: `update`, `push`, `result`; `audit-exceptions.json` deleted.
- [x] 1.6 `AGENTS.md`, this change, `release-from-tags` archived.
- [x] 1.7 `.changeset/ci-ttv-336-release-with-changesets.md`, in the last commit.

## 2. Acceptance criteria and checks

- [x] 2.1 No shared action, secret scan or audit file remains. Check:
      `git grep -nE 'torrent-tv/workflows/actions|create-pull-request|push-to-main|set-bot-identity|gh workflow run dependencies|audit-exceptions|check-audit|addon-install|npm-package-ready|0\.0\.0-development' -- .github package.json AGENTS.md`
      prints only the one `gh workflow run dependencies.yml -R torrent-tv/ha-addon` line of `publish`,
      and `git grep -n 'HEAD:refs/heads/main' -- .github/workflows` finds two lines: the force-push of
      `version` and the push of `dependencies.yml`.
- [x] 2.2 Every dependency is exact and the tools are exact devDependencies. Check:
      `bash scripts/check.sh pins`; `git grep -nE 'uses: [^ ]+@v[0-9]+$' -- .github` prints nothing.
      `pins` fails on `^7.8.6` and `tools` fails on a changed `.node-version` (run locally).
- [x] 2.3 `npm test` and `npx changeset status --since=origin/main` pass here, except the failures
      the Mac has without the Home Assistant host's tools (design.md, Fact 10). `bash scripts/check.sh test`
      stops itself after 900 s and says so (design.md, Fact 11).
- [ ] 2.3b The Checks run of the pull request passes, `Workflows are valid` included.
- [ ] 2.4 After the merge: a `force_push` on `refs/heads/main` by `torrent-tv-release[bot]` follows
      the `pr_merge`; this pull request's changeset commit is on `main` with its author, author time
      and header unchanged, `package.json` `2.107.81`, `## 2.107.81` in `CHANGELOG.md`, the changeset
      deleted, and no commit `chore(release)`. Check:
      `gh api "repos/torrent-tv/proxy/activity?ref=refs/heads/main"`, `git show --stat <sha>`.
- [ ] 2.5 The run of that push: `version` logs `no pending changesets`; `checks` and `build` pass;
      `publish` publishes `@torrent-tv/proxy@2.107.81` with provenance and `gitHead` equal to the
      rewritten commit, tag `v2.107.81` is on it and its GitHub Release body equals the
      `CHANGELOG.md` section. Check: run URL,
      `npm view @torrent-tv/proxy@2.107.81 gitHead dist.attestations`, `git rev-list -n 1 v2.107.81`,
      `gh release view v2.107.81 --json body`.
- [ ] 2.6 `publish` logs `started torrent-tv/ha-addon dependencies.yml with proxy-version=2.107.81`;
      ha-addon's `Dependencies` run (event `workflow_dispatch`) logs `npm serves @torrent-tv/proxy@2.107.81`
      and pushes `fix(proxy): install proxy 2.107.81 #ttv-387`.
- [ ] 2.7 Window: the time from `pr_merge` to `force_push`, with the `version` job's step times, is
      recorded on torrent-tv/meta#336.
- [ ] 2.8 The first `Dependencies` run after the merge ends in one of two ways: it logs `no updates`
      and `0 open Dependabot alerts` and pushes nothing, or it pushes its commits as the release App
      with the headers of the plan, each versioned, checked and published. `update` has only
      `contents: read` and `vulnerability-alerts: read`, no environment and no `secrets.`; `push` has no
      `npm`, `npx` or test command. The `node-datachannel` 0.33.6 and `werift` 0.27.0 bump it proposes
      (design.md, Fact 9) is for the owner to accept or hold back.
- [ ] 2.9 Every commit on `main` after this change either matches a merged pull request commit or is by
      `torrent-tv-release[bot]` with a header ending in `#ttv-386` or `#ttv-387` and only
      `package.json`, `package-lock.json` and `.changeset/*.md`, and every `force_push` has actor
      `torrent-tv-release[bot]`.
