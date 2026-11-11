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
- [x] 2.3b The Checks run of the pull request passes, `Workflows are valid` included.
      Shown: Checks run 42897488543 of the pull request, success (meta#336 acceptance check,
      comment 6781047118).
- [x] 2.4 After the merge: a `force_push` on `refs/heads/main` by `torrent-tv-release[bot]` follows
      the `pr_merge`; this pull request's changeset commit is on `main` with its author, author time
      and header unchanged, `package.json` `2.107.81`, `## 2.107.81` in `CHANGELOG.md`, the changeset
      deleted, and no commit `chore(release)`. Check:
      `gh api "repos/torrent-tv/proxy/activity?ref=refs/heads/main"`, `git show --stat <sha>`.
      Shown: proxy#63 `pr_merge` 2026-11-10 20:44:47 UTC, `force_push` by
      `torrent-tv-release[bot]` 6e73c701 -> 93163ea1 at 20:45:10; 93163ea1 keeps author, author
      time and header of the pull request commit 766557bb, changes `package.json`,
      `package-lock.json` and `CHANGELOG.md` (`## 2.107.81`), holds no changeset and no
      `chore(release)` follows (comment 6781047118, AC 1).
- [x] 2.5 The run of that push: `version` logs `no pending changesets`; `checks` and `build` pass;
      `publish` publishes `@torrent-tv/proxy@2.107.81` with provenance and `gitHead` equal to the
      rewritten commit, tag `v2.107.81` is on it and its GitHub Release body equals the
      `CHANGELOG.md` section. Check: run URL,
      `npm view @torrent-tv/proxy@2.107.81 gitHead dist.attestations`, `git rev-list -n 1 v2.107.81`,
      `gh release view v2.107.81 --json body`.
      Shown: run 42898344338: `version` logs `no pending changesets`, `checks` pass (`tests 3254
      pass 3254 fail 0`), `publish` logs `published @torrent-tv/proxy@2.107.81 from 93163ea`,
      `pushed tag v2.107.81 on 93163ea` and `created GitHub Release v2.107.81`; `npm view
      @torrent-tv/proxy@2.107.81 gitHead` is 93163ea149dc... with provenance
      `https://slsa.dev/provenance/v1`; the release body equals the `CHANGELOG.md` section
      (comment 6781047118, AC 1).
- [x] 2.6 `publish` logs `started torrent-tv/ha-addon dependencies.yml with proxy-version=2.107.81`;
      ha-addon's `Dependencies` run (event `workflow_dispatch`) logs `npm serves @torrent-tv/proxy@2.107.81`
      and pushes `fix(proxy): install proxy 2.107.81 #ttv-387`.
      Shown: the `publish` job of run 42898344338 logs `started torrent-tv/ha-addon
      dependencies.yml with proxy-version=2.107.81`; ha-addon run 42898937642
      (`workflow_dispatch`) logs `npm serves @torrent-tv/proxy@2.107.81 after 123 s` and pushes
      `fix(proxy): install proxy 2.107.81 #ttv-387` (ha-addon 55858e2) (comment 6781047118, AC
      3). The same chain repeated for 2.107.92: proxy run 42989922601 logs `started
      torrent-tv/ha-addon dependencies.yml with proxy-version=2.107.92`, ha-addon run
      42990439482 logs `npm serves @torrent-tv/proxy@2.107.92 after 260 s` and pushed ha-addon
      9ddc69b.
- [x] 2.7 Window: the time from `pr_merge` to `force_push`, with the `version` job's step times, is
      recorded on torrent-tv/meta#336.
      Shown: `pr_merge` 20:44:47, `force_push` 20:45:10 (23 s); `version` job from 20:44:55: app
      token 1 s, checkout 3 s, setup-node 1 s, `npm ci` 5 s, version 3 s; recorded on
      torrent-tv/meta#336 as "Version window (AC 15)" (comment 6781047118).
- [x] 2.8 The first `Dependencies` run after the merge ends in one of two ways: it logs `no updates`
      and `0 open Dependabot alerts` and pushes nothing, or it pushes its commits as the release App
      with the headers of the plan, each versioned, checked and published. `update` has only
      `contents: read` and `vulnerability-alerts: read`, no environment and no `secrets.`; `push` has no
      `npm`, `npx` or test command. The `node-datachannel` 0.33.6 and `werift` 0.27.0 bump it proposes
      (design.md, Fact 9) is for the owner to accept or hold back.
      Shown: `Dependencies` run 42989425984 (`workflow_dispatch`, 2026-11-11 08:44 UTC, success)
      logged `0 open Dependabot alerts`, tested one prepared commit (`tests 3285 pass 3285`,
      `checks passed on: fix(deps): update dependencies #ttv-386`) and pushed it as
      `torrent-tv-release[bot]` (`pushed 1 commits d74e921..8ae6c2ad`). The push run 42989870775
      versioned it in place: `force_push` 8ae6c2ad -> 43f1179d, `## 2.107.92` in `CHANGELOG.md`
      (werift 0.24.4 -> 0.27.0), `publish` of run 42989922601 logged `published
      @torrent-tv/proxy@2.107.92 from 43f1179`, tag `v2.107.92` and the GitHub Release; `npm
      view @torrent-tv/proxy@2.107.92 gitHead` is 43f1179d. The owner ruled the werift 0.24.4 ->
      0.27.0 update a non-breaking one and the `ncu --target minor` behaviour correct (comment
      6791127421), and approved step 5, the push to `main` without a pull request (comment
      6791321249). `update` has only `contents: read` and `vulnerability-alerts: read`, no
      environment and no `secrets.`, and `push` has no `npm`, `npx` or test command (comment
      6781047118, AC 9(b)).
- [x] 2.9 Every commit on `main` after this change either matches a merged pull request commit or is by
      `torrent-tv-release[bot]` with a header ending in `#ttv-386` or `#ttv-387` and only
      `package.json`, `package-lock.json` and `.changeset/*.md`, and every `force_push` has actor
      `torrent-tv-release[bot]`.
      Shown: on 2026-11-11 every commit after c7f63aa2 is a merged pull request commit (author
      unchanged, committer the coordinator or the release App after versioning) or the release
      App's own 43f1179d `fix(deps): update dependencies #ttv-386` (`package.json`,
      `package-lock.json`, and `CHANGELOG.md`, which `changeset version` writes); every
      `force_push` since the switch merge (proxy#63, 2026-11-10 20:44:47 UTC) has actor
      `torrent-tv-release[bot]` (11 of 11), the other entries are 10 `pr_merge` by the
      coordinator and one `push` by the release App (comment 6781047118, AC 5, checked again
      against `origin/main` 43f1179d).
- [x] 2.10 The copy check compares each commit of a pull request with the whole history of `main`,
      and a changeset must be one plain sentence. Check: `bash scripts/check.sh changesets-selftest`
      exits 0 (the earlier range comparison passes the copy, `copies` fails it; each format rule fails
      its bad input), and the step "Changeset checks fail on bad input" passes in `Checks`.
- [x] 2.11 The step "Test every commit, oldest first" of `dependencies.yml` runs `.githooks/commit-msg` on
      each prepared commit and stops at a refused one. Check: in a scratch repository with a stub `npm` and
      a stub `scripts/check.sh`, the step keeps the commit before one whose body has a line of 120
      characters and stops there, and passes a commit made by the helper `commit` (folded body); the leg
      `commit-msg-bot` of the next commit runs exactly that.
- [x] 2.12 The workflow files are checked: `workflow-pins`, `workflow-tokens`, `commit-msg-bot` and their proof on
      bad input. Check: `bash scripts/check.sh workflow-selftest` exits 0, the three legs exit 0 on `main`,
      and the steps "Workflow tools are pinned exactly", "The dependency job gives no token to package
      code, and each pushing job holds its own", "The dependency job refuses a commit message the hook
      refuses" and "Workflow checks fail on bad input" pass in `Checks`.

## 3. Test plan of the closing stage: no placeholder version (2026-11-11)

Change of the stage: the version `0.0.0-development` leaves the tests (AC 4(c)).

1. Scope and risk. In scope: `test/no-torrent/install-native-script.test.js` (the fake manifest of the
   case that installs the native package) and `test/no-torrent/no-placeholder-version.test.js` (the
   check). Out of scope: `scripts/install-native.sh`, which never reads the manifest `version`, so the
   fixture value changes no behaviour. Risk is low: one positive case and one negative. Nothing touches
   torrent startup.
2. Level and command (unit, one file):
   `node --require ./test/no-torrent/support/refuse-torrent.cjs --test test/no-torrent/no-placeholder-version.test.js`
3. Cases. Positive: with `1.0.0` in the fake manifest the check and `install-native-script.test.js` pass.
   Negative: with the placeholder in any file of `test/`, comments included, the check fails and names
   `<file>:<line>`. Boundary: the check builds the name from two parts, so it does not find itself.
4. Rules and exit. Before the fixture changed, the check failed with the actual value
   `test/no-torrent/install-native-script.test.js:113`; after it, the check passes. The test uses no
   timer, no network and no file outside `test/`. Exit is `npm test`.

## 4. Test plan of the closing stage: the dependency job starts from the tip of main (2026-11-11)

Change of the stage: the job `update` of `.github/workflows/dependencies.yml` checks out `main`
(`ref: main`), so a run queued by `concurrency: dependencies` does not start from the commit that was
`github.sha` when it was started (AC-REF). The defect, with its measurements: ha-addon runs 43013341200
and 43014115480 (2026-11-11). The second one was queued behind the first, checked out the dispatch-time
commit, had its push refused, its rebase stopped on `torrent_tv_proxy` package files, and it ended
`failure`; proxy 2.107.95 reached the add-on only by a manual run. The same file is in proxy, server,
ha-addon and infra.

1. Scope and risk. In scope: the leg `workflow-refs` of `scripts/check.sh` and its synthetic cases in
   `workflow-selftest`, both in the block "The checks of the workflow files", which is byte-identical in the
   four repositories. Out of scope: the checkout of the job `push` (it takes `needs.update.outputs.base`,
   the commit the patches were made on, on purpose), the other legs (unchanged), and the behaviour of
   GitHub's `concurrency` (a platform fact, not our code). Risk is low: no torrent startup, no runtime
   code; a wrong leg either lets a stale checkout through (the defect) or refuses a correct file. Depth:
   one positive case and every negative form listed in part 3, each refusal proved by its own message.
2. Level and command (unit of the shell leg, with the fixtures built by `yq` in a scratch directory):
   `bash scripts/check.sh workflow-refs` (the real file) and `bash scripts/check.sh workflow-selftest`
   (the proof that the leg fails on bad input and passes on good). The runner needs `yq` at the
   `YQ_VERSION` of the script. Exit is `bash scripts/check.sh all`, the command `dependencies.yml` and
   `main.yml` run.
3. Cases, each one `refs_case pass|fail` in `workflow_selftest`. Positive: `ref: main` on the `update`
   checkout while the `push` checkout keeps its own ref. Negative: the `update` checkout with no `ref`;
   with `${{ github.sha }}`; with `${{ github.ref }}`; with another branch; with a tag; with an empty `ref`;
   a second `update` checkout with no `ref` after a first one at `main` (every checkout is read); the
   `push` checkout at `main` while the `update` one has none (the right job is read); the job `update`
   without a checkout (the error line says `has no actions/checkout step`; the matches are counted with
   `[...] | length`, because in yq 4.54.1 a string literal at the end of a pipe prints even with no match);
   a workflow without the job `update` and no `dependencies.yml` (each error line is checked). Boundary: an
   empty string and a missing key are both refused. Not covered: a checkout through a local action or a
   `git fetch` in a `run:` (the file has none; a new form is a new case with the change that adds it).
4. Rules and exit. The test commit keeps `bash scripts/check.sh all` and `workflow-selftest` green: it
   leaves the leg out of `all` and `main.yml` and has no case that runs the leg on the repository's own
   `dependencies.yml`, because that case fails until the fix. The failing demonstration is the leg called by
   name: before the fix, `bash scripts/check.sh workflow-refs` exits 1 in each repository with
   `a checkout of job update has ref "", not main`; after it, it exits 0. The synthetic cases pass already, and
   show the leg failing on bad input and passing on `ref: main`; turning the "no checkout" branch of the leg
   into `return 0` makes `workflow-selftest` fail. The implementer commit adds exactly these lines:
   1. `dependencies.yml`, the `update` checkout: `ref: main` under `with:`.
   2. `scripts/check.sh`, `all`: `workflow_tokens && workflow_refs && commit_msg_bot` in place of
      `workflow_tokens && commit_msg_bot`.
   3. `.github/workflows/main.yml`, job `checks`, after the tokens step:
      `- name: The dependency job starts from the tip of main` with
      `run: bash scripts/check.sh workflow-refs`.
   4. `scripts/check.sh`, `workflow_selftest`, first line of the cases of `refs_case`:
      `refs_case pass "this repository's file" ''`.
   The cases use no network and no file outside their scratch directory. The leg is a check, not a
   `node:test` test, so it has no `todo` marker.
