# Tasks: Release the proxy from tags and changesets

Parent: torrent-tv/meta#336 step 2. Branch `ci/ttv-336-release-from-tags`.
One commit `ci(release): release from tags and changesets #ttv-336` holds this
change and the code it specifies. No failing-test commit: nothing at runtime
changes (design.md "Version at runtime"); the checks are CI runs (section 3).

## 1. Files

- [ ] 1.1 `.github/workflows/main.yml`: replace the `check-changelog` step
      (`:84-88`) with `check-changesets`; replace the release steps `:138-161`
      with `release-plan`, "Publish to npm" with the gitHead guard, and
      `release-tag`; reword the concurrency comment (`:120-121`); keep the
      add-on steps `:163-182` as they are. Exact YAML: design.md "Release job".
- [ ] 1.2 `.github/workflows/main.yml:15`: `bump` description "Least release
      step (a feat still releases minor)".
- [ ] 1.3 `.github/workflows/dependencies.yml`: add `changeset: "true"` to the
      `update-dependencies` `with:` (next to `ships-lockfile`).
- [ ] 1.4 `package.json:3`, `package-lock.json:3` and `:9`:
      `"version": "0.0.0-development"`. Edit by hand or with
      `npm version 0.0.0-development --no-git-tag-version --ignore-scripts`;
      `git diff package-lock.json` shows those two lines only.
- [ ] 1.5 `CHANGELOG.md`: insert at the top, above `## 2.107.64`:
      "Releases after 2.107.64 are described at
      https://github.com/torrent-tv/proxy/releases; this file is no longer
      updated. A pull request describes its change in `.changeset/` (see
      `AGENTS.md`, Changesets)." Add no `## Unreleased`.
- [ ] 1.6 Remove `.githooks/pre-push` (its only rule is the `## Unreleased`
      entry).
- [ ] 1.7 `AGENTS.md`: replace "## Changelog" (`:390-396`) with
      "## Changesets": every pull request adds `.changeset/<branch with / as
      ->.md` holding one or two bullets `- **New**: …`, `- **Fix**: …` or
      `- **Chore**: …` for a viewer (continuation lines indented by two
      spaces, no blank lines, lower-case file name); nothing else may live in
      `.changeset/`; changesets are never edited after merge or deleted; the
      release notes are the changesets added since the last tag; never edit
      the `package.json` version (`0.0.0-development` in git). CI
      (`check-changesets`) refuses a pull request without one.
- [ ] 1.8 `AGENTS.md` "## Release" (`:398-424`): steps become (1) plan the
      version from the newest `v*` tag and the commits after it and write it
      into `package.json`/`package-lock.json` of the workspace only; (2)
      publish to npm (skipped when npm holds the version from this commit);
      (3) tag the merged commit and create the GitHub release from the
      changesets; (4) unchanged add-on step. Nothing is committed to `main`.
      A manual run's `patch`/`minor` is the least step and still needs a
      changeset since the last tag. Re-running is safe: a tag holding the
      commit skips publication.
- [ ] 1.9 `openspec/config.yaml:13-16`: replace the CHANGELOG and
      ha-addon-bump lines with "Every pull request adds a changeset
      `.changeset/<branch>.md` (see AGENTS.md). package.json holds
      0.0.0-development; the release takes the version from tags. A proxy
      release updates the add-on by itself."
- [ ] 1.10 `.changeset/ci-ttv-336-release-from-tags.md` (added last, see 3.1):
      `- **Chore**: Releases are made from tags with no release commit on
      main; release notes now live in GitHub Releases
      (https://github.com/torrent-tv/proxy/releases) instead of CHANGELOG.md.`
- [ ] 1.11 Local: `npm ci && npm test` passes. The workflows are checked by
      CI's `Workflows are valid` step (actionlint).

## 2. Constraints

- No file other than changesets under `.changeset/` (design.md Fact 4).
- No change outside the files in section 1; no source or test change.
- `release-plan`, `release-tag`, `check-changesets` from `@main`; no input
  that step 1 does not define.
- Merge by rebase (the only method allowed); do not merge while another
  proxy release run is in progress.

## 3. Acceptance (issue #336 acceptance 1, 2, 4 for proxy)

- [ ] 3.1 The PR check fails without a changeset and passes with one: push
      the commit first without `.changeset/ci-ttv-336-release-from-tags.md`;
      the `Pull request adds a changeset` step fails with "this pull request
      adds no changeset" (record the run URL). Amend the commit to add it,
      force-push; the step passes and prints `changesets added:
      .changeset/ci-ttv-336-release-from-tags.md` (record the run URL).
- [ ] 3.2 Acceptance 1 after the merge: the `main.yml` push run is green;
      `git fetch --tags && git log --format='%h %s' v2.107.64..origin/main`
      shows no `chore(release)`; `git rev-parse v2.107.65^{commit}` equals
      `origin/main` at the merge; `gh release view v2.107.65 -R
      torrent-tv/proxy --json body -q .body` equals the changeset text;
      `npm view @torrent-tv/proxy@2.107.65 gitHead` equals the same commit and
      `npm view @torrent-tv/proxy version` is `2.107.65`; the add-on step
      ends green (ha-addon gets `fix(proxy): install proxy 2.107.65`).
- [ ] 3.3 Acceptance 4: two pull requests, each adding its own changeset
      (the next real ones, or two trivial `docs` fixes), are open together;
      after the first merges, the second shows `mergeable: MERGEABLE`
      (`gh pr view <n> --json mergeable`) and its checks stay green without a
      changelog fix-up.
- [ ] 3.4 Acceptance 2: merge those two within one minute. Both `main.yml`
      runs are green; either two tags each on its own merged commit with that
      pull request's changeset as notes, or one tag on the later commit whose
      notes hold both changesets and a second run that reports "already holds"
      and skips publication. `npm view @torrent-tv/proxy versions` holds every
      tagged version.

## 4. After merge (not in this pull request)

- [ ] 4.1 Open pull requests #47 and #24 move their `## Unreleased` entry
      into `.changeset/<branch>.md` and drop the `CHANGELOG.md` change when
      they rebase.
- [ ] 4.2 Step 3 (ha-addon dispatch) replaces the add-on steps.
