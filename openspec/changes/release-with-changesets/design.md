# Design: Release the proxy with changesets

Facts were read from the files and runs named, or measured; each says which. Analysis is
marked. The steps `version`, `plan`, `checks`, `rebase-prs` and `dependencies.yml` are
copies of the server's (torrent-tv/server `main`, `openspec/changes/release-with-changesets/design.md`,
and infra's, which describes their rules); only what differs for the proxy is written out here.

## Facts

1. State of proxy `main` at c7f63aa2 (`git`, 2026-11-10): the newest tag is `v2.107.80`, on
   c7f63aa2 itself; `v2.107.65` to `v2.107.80` are the 16 tags after the last CHANGELOG section
   (`## 2.107.64`). `package.json` and the lock held `0.0.0-development`. `CHANGELOG.md` began
   with a notice that it was frozen. `.changeset/` held 17 files in our own format, each
   consumed by one release: two by `v2.107.65` (`ci-ttv-336-release-from-tags`, added by
   41fc84f7, and `docs-ttv-300-consolidate-rules`, f0f4e861) and one by each of `v2.107.66`
   to `v2.107.80` (`git tag --contains <commit that added it>`, first tag). The newest,
   `chore-ttv-399-drop-detect-secrets`, was added by c7f63aa2 and consumed by `v2.107.80`.
2. `@changesets/cli` 3.0.3, run in a scratch clone of this change's history with two probe
   changesets (a patch, a minor) on three commits (changeset, plain, changeset): `version`
   versioned them 2.107.81, 2.107.81 (the plain commit, which carries the version of its parent
   and is unchanged otherwise) and 2.108.0, each in its own commit, the committer being the
   release App; a second run logged `no pending changesets` and left the tip unchanged. The
   CHANGELOG entry of a changeset without a SHA reads `- Probe one.`
3. The `publish` step ran in the same scratch clone with `changeset publish` and `gh release`
   replaced by stubs (no publication happened; `npm view` and `changeset git-tag` were real):
   `changeset git-tag` made `v2.107.81` and `v2.108.0` on the two version commits, the tags
   were pushed to the scratch origin, the Release notes were the `## <v>` sections, and
   `npm view @torrent-tv/proxy@2.107.80 gitHead` answers `c7f63aa2...`, the commit it was
   published from, which is the check that skips a published version.
4. The npm package: `@torrent-tv/proxy@2.107.80` has provenance (`dist.attestations`,
   SLSA provenance v1), `gitHead` c7f63aa2 and the dist-tag `latest` (`npm view`).
   Trusted publishing is configured on npmjs.com for `torrent-tv/proxy`, workflow `main.yml`,
   environment `production`; this change keeps the file name and the environment. npm 11.19.1
   is bundled with Node 24.22.2 (`scripts/check.sh tools`), above the 11.5.1 trusted
   publishing needs, so no `npm install --global npm` step remains.
5. `@changesets/cli` 3.0.3 `publish` runs `npm info <name>` and then
   `npm publish --access public --tag latest --json` for a version npm lacks, and passes over
   an "already published" refusal (`dist/getPublishPlan.mjs`, read in the installed package).
   It sets no `--provenance`; `NPM_CONFIG_PROVENANCE=true` in the step does.
6. Dependabot alerts are enabled on this repository (`gh api repos/torrent-tv/proxy/vulnerability-alerts`
   answered 204); one alert exists, number 1, `GHSA-2p57-rm9w-gvfp` (`ip`), state `dismissed`,
   reason `not_used`, by SilentImp, with a comment that cites `audit-exceptions.json`. No alert is open.
   So `audit-exceptions.json` is deleted with no new dismissal needed.
7. The release App `torrent-tv-release` has `actions: write`, `contents: write`,
   `pull_requests: write` and `workflows: write` (`gh api /apps/torrent-tv-release`). The proxy
   `production` environment holds the secret `RELEASE_APP_PRIVATE_KEY` and the variable
   `RELEASE_APP_CLIENT_ID`; `main` has no ruleset; only rebase merge is allowed.
8. ha-addon `main` has `.github/workflows/dependencies.yml` with the `workflow_dispatch` input
   `proxy-version` (torrent-tv/ha-addon#11, merged); it waits for npm to serve the version and
   installs it. A dispatch reaches only a workflow on the default branch.
9. `npm-check-updates` 23.1.1 `--target minor --dep prod,dev,optional` on this tree proposes
   `uint8-util` 2.2.6 to 2.3.2, `node-datachannel` 0.32.3 to 0.33.6 and `werift` 0.24.4 to
   0.27.0 (ncu counts a `0.x` minor as a minor). `uint8-util` and `webtorrent` are pinned on
   purpose: WebTorrent 2.8.5 accepts `uint8-util` ^2.2.5, but 2.3.x breaks it (`arr2hex`;
   `knip.jsonc`, `CHANGELOG.md` 2.9.44, commit 37ebe441), and no check that starts no real
   torrent can see that.
10. With `node-datachannel` 0.33.6, `werift` 0.27.0 and the other updates of fact 9 applied
    (scratch clone, `npm ci --foreground-scripts`, then `npm test`): the install succeeded with
    one warning (`bufferutil@4.2.0` has an install script that `allowScripts` does not cover,
    npm's `allowScripts` names exact versions), and the no-torrent tests gave 4 failures out of
    3251. The failures are the macOS ffprobe cases and a timing case that also fails on the
    unchanged tree: `AVI libxvid B pictures retain presentation order without idx1`, the two
    `ffprobe reads synthetic ... packet bytes` cases and one flaky case in
    `auto-quality-step.test.js` (3 failures, then 1, then 0 in three runs of that file).
11. `npm test` hung for 2 h 39 min in the first implementer's test loop, on one test process,
    `test/no-torrent/seek-frees-the-viewers-requests.test.js` (state S, 0.1 % CPU; the
    `--test-timeout=0` on its command line is the value `node --test` gives every test process,
    not a setting here). The file run alone 20 times hung 6 times on a clean worktree of
    `origin/main` (c7f63aa2) and 6 times on this branch, so the change did not cause it.
    A hung process held only periodic timers and three non-persistent `fs.watch` handles; its
    second test waited for a request that the store never woke, with the 256-byte segment on disk
    and `getFileStream` answering `file` when asked directly; the raw `fs.watch` callback of that
    directory was never called for the segment. The production `SegmentStore`, three outputs given
    their directories, a listener on the first, a segment written into it after a delay (macOS,
    Node 24.22.2): 28 of 150 writes never reached the listener at 0 ms, 36 of 150 at 2 ms, 41 of 150
    at 5 ms, none of 150 at 10 ms and later. Events written 25 ms apart arrived on alternate probes:
    the platform reports in batches 51 ms apart. The same cause failed single runs of two checks of
    `segment-closed-on-both-branches.test.js` and one of `failed-run-production-goes-on.test.js` after
    their limits of 10 s (1 of 25, 1 of 121, and 1 of 8 full runs, before the change).
    The first commit gives each of those checks a proof that the watch reports before it writes
    (`helpers/store-watch.js`) and the waits of `seek-frees-the-viewers-requests` a limit.
    After it: 150 runs of `seek-frees-the-viewers-requests`, 120 of `segment-closed-on-both-branches`
    and 100 of `failed-run-production-goes-on` pass alone, and 12 full `npm test` runs on the final
    tip had no hang and no failure of these checks; on `origin/main` one of three full runs hung.
    Not measured: Linux (inotify) and Windows, and whether a segment written within 10 ms of a watch ever
    happens in production (the first segment of an output comes after ffmpeg has started). Another
    flake is not touched: `auto-quality-step.test.js` run alone fails in 24 of 25 runs on `origin/main`
    and 21 of 25 here on this Mac (the cases differ from run to run, among them `a stream that
    publishes no variants is left alone, and said so once`), a timing cause not investigated.
12. `scripts/check.sh tools` and `pins` fail on bad input: a `.node-version` of 24.22.1 and a
    `^7.8.6` for `semver` (run locally).
13. `package-lock.json` has no entry beyond the 40 packages of the three added tools; no existing
    entry changed version (comparison of the lock before and after).

## Decisions (analysis)

### The migration

The switch commit sets `package.json` to the newest tag's version, `2.107.80`, and converts the
released changesets into the lines `changeset version` writes for a released changeset, under the
section of the first tag that held each, as `- <sha7 of the commit that added it>: <text>`, with
the `- **Chore**:`-style prefix dropped. The files are deleted, so the first pending changeset is
this pull request's own, in its last commit. The commits before it (migration, scripts, workflows)
are never rewritten, so `version` does not replay a commit that changes a workflow file.

### What a version is

`publish` finds versions as the commits since the newest tag's own commit that add a `## <x.y.z>`
heading to `CHANGELOG.md` and change the `version` of `package.json` against their parent. The
migration commits add headings but change no version, so they are not released.

### Publication

- `publish` is a job of its own (`needs: [checks, build]`), in the environment `production`, with
  `id-token: write` and `contents: write`, in the concurrency group `publish` (queued, never
  cancelled). For each new version, oldest first, it publishes from that version's commit
  (`git switch --detach`, `changeset publish --no-git-tag`) unless npm has the version, tags it
  with `changeset git-tag`, pushes the tag and creates the Release from the CHANGELOG section.
  The package comes before the tag.
- A version that npm holds from another commit fails the step, naming both commits, as the
  release before it did.
- npm serves a version only after it has processed it (6.5 minutes for 2.89.8). A re-run inside
  that time may not see the version; the second publication is refused as already published, which
  `changeset publish` passes over.

### The add-on

- The last two steps of `publish` mint a token for ha-addon only (`permission-actions: write`) and run
  `gh workflow run dependencies.yml -R torrent-tv/ha-addon -f proxy-version=<newest>`. The newest
  version is that of the last commit the step handled, which is the one this run released; a run
  that released nothing new passes the newest tagged one, and ha-addon ignores a version that is not
  newer than its pin.
- The token holder runs no package code of its own beyond `changeset`, installed with
  `--ignore-scripts` from the lock. A separate job would add a job and a second checkout for no
  other gain, so the plan's "last step of `publish`" stands.
- ha-addon's workflow waits until npm serves the version, so no wait is written here.

### Checks

- A pull request has one `checks` leg per commit that adds a changeset and one for its head; each
  runs the apt ffprobe setup, the native download cache, the install and the tests. The head also runs
  the commit, branch, workflow, changeset and copy checks, which need the installed
  `@changesets/cli` and so come after the install. The job `build` builds the image once, for the head.
- `ci-native-downloads.test.js` reads the job `checks` as text; the job keeps its name, its step
  names and the order restore, install, save, tests.
- `Dependencies are pinned exactly` runs in every leg (`scripts/check.sh pins`).
- The `Workflows are valid` step (actionlint 1.7.12) keeps its documented ignores and one more for
  the permission scope `vulnerability-alerts`.

### Dependency updates

- `ncu --target minor` holds back `uint8-util` and `webtorrent` (fact 9): a pin the repository
  documents, whose breakage is invisible to checks that start no real torrent. This is the
  plan's own mechanism for a package that a bump must not move (revision 5, W7.3).
- A bump of `node-datachannel` or `werift` (a `0.x` minor) is applied as the owner's "minor"
  says. Fact 10 shows the no-torrent suite does not reject it. Whether it works against real peers
  is unknown until the add-on runs it on the Home Assistant host; this is an open question for the
  coordinator and the owner (recommended: hold both back until a field check approves them).
- `allowScripts` names exact versions, so a bump of a package listed there is not covered by it.
  The lock marks `bufferutil`, `ffmpeg-static`, `node-datachannel`, `utf-8-validate`, the
  `@ffprobe-installer` platform packages and `utp-native` with an install script. Measured: the
  install with `bufferutil@4.2.0` (not covered) warned and went on (fact 10). Not measured: what
  a bump of `ffmpeg-static` or the ffprobe packages does when its script is not approved. A prepared
  commit whose tests fail is not pushed and keeps the run red until an agent task updates the entry.
- The commit is `fix(deps)` when `dependencies` of `package.json` change (the lock file is not
  published), else `chore(deps)`. The alert commit is always `fix(deps)`.
- `check.sh all` runs the install with its scripts, so every prepared commit is tested in the tree
  that CI uses.
- `check.sh` runs `install`, `test` and `image` under `timeout -k 10 <limit>` and logs
  `::error::<step> did not finish within <limit>s; it was stopped` when it stops one (status 124).
  The limits, 900 s, 900 s and 1200 s, are chosen: the same steps took 13 s, 74 s and 45 s on a GitHub
  runner and the tests 39 s on a Mac. Proven on bad input: with a limit of 3 s and an `npm` that sleeps,
  the step logs the error, exits 124 and leaves no child process.

### Copy and format checks of the changesets (2026-11-10, found by the acceptance check)

- Measured defect: `proxy` released the note of one changeset in two versions (2.107.82 and
  2.107.83). A branch cut from the old tip of `main` in the 22 s between a merge and the force-push
  of `version` kept the old commit; a plain `git rebase origin/main` kept it too, because its patch no
  longer equals the rewritten commit (the version files differ), and it added the changeset again. The
  step "Pull request carries no copy of a commit on main" compared only `origin/main..HEAD` with
  `HEAD..origin/main`, which is empty once the branch sits on top of `main`.
- A check of the path (`git log origin/main --diff-filter=A -- <changeset>`) does not see it either:
  the rewritten commit never holds the changeset, so `main` has never added that path (measured on
  `.changeset/docs-ttv-336-link-shared-rules.md`). The step compares each commit of the pull request
  with the whole history of `main` by author e-mail, author time and subject, which a rewrite and a
  rebase keep. `bash scripts/check.sh copies <base> <head>`.
- Measured defect: a changeset in the old `- **Fix**: ...` format was released as
  `- - **Fix**: ...` (proxy 2.107.85). The step "Changesets of the pull request are one plain
  sentence" (`bash scripts/check.sh changeset-format <base> <head>`) refuses a changeset whose text
  starts like a list, heading, bold label, quote or code, has more than one paragraph, has no text, or
  has text and no package. An empty changeset (`changeset add --empty`) is allowed only where
  `CHANGESET_EMPTY_ALLOWED=yes` (ha-addon). The rule is in `torrent-tv/workflows` CONTRIBUTING.md,
  "Versions and releases", item 1.
- Proof on bad input: `bash scripts/check.sh changesets-selftest` (the step "Changeset checks fail on
  bad input") builds the exact copy case in a scratch repository, shows that the earlier range
  comparison passes it and that `copies` fails it, and runs each format rule on a bad and a good file.
  The step runs before the two checks it proves, so a refusal never hides it. The self-test clears every
  variable of `git rev-parse --local-env-vars`, and a case shows that a repository named by
  `GIT_OBJECT_DIRECTORY` and `GIT_COMMON_DIR` stays unchanged.
- Known limits of the format check (reviewed 2026-11-10, not the measured defect): two sentences in one
  paragraph pass, because the number of sentences is not decidable from the text; `__name` and a wrapped
  line starting with `- ` are refused. Of the copy check: a copy whose author date was reset
  (`rebase --ignore-date`, `commit --amend --reset-author`) or whose subject was reworded is not seen.

## Blockers and unknowns

1. Not run before the merge: `version` on this repository's `main` (it ran in a scratch clone of this
   history), the real `changeset publish` under npm trusted publishing (stubbed in the scratch run;
   the OIDC publication and the provenance are checked on the first release), and the dispatch to
   ha-addon.
2. The window from merge to force-push on this repository is unknown until the first release.
3. Whether the `Checks` legs of every changeset commit (about 3.5 minutes each, in parallel) are
   acceptable is measured by the first pull request that has two changeset commits.
4. A bump of `node-datachannel` or `werift` (fact 9) is the first change the daily run proposes.

## Five answers

1. The viewer: nothing on the page changes. A proxy release reaches npm as before, each version
   published from its own commit, and reaches the add-on without a pull request.
2. Cost to build: `main.yml`, `dependencies.yml`, `scripts/check.sh`, the `package.json` and lock
   change, two test edits.
3. Cost to maintain: `version`, `rebase-prs` and `dependencies.yml` are copies of the others' and
   change together (AGENTS.md Process 6); the shared actions `release-plan`, `release-tag`,
   `check-changesets`, `update-dependencies` and `addon-install-proxy` are no longer used here.
4. Alternatives: a Version Packages pull request and a separate release commit were withdrawn by
   the owner; `repository_dispatch` for the add-on was the planner's recommendation and the owner chose
   `workflow_dispatch`.
5. Undo: revert the pull request; rewritten history is not restored, but tags, packages and
   versions stay valid.
