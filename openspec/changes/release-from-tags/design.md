# Design: Release the proxy from tags and changesets

Line numbers at proxy `2a3b3033` (2.107.64), `torrent-tv/.github` `bc381ae`.

## Facts

1. The newest reachable tag is `v2.107.64` on `2a3b3033`. `release-plan`
   (`scripts/release-from-tags.mjs`) plans `last tag + bumpOf(commits since)`;
   any conventional non-release commit gives at least patch, so this pull
   request's `ci(release)` commit releases 2.107.65 after the merge.
2. `release-plan` writes the version through `npm version
   --no-git-tag-version --allow-same-version` (`scripts/write-version.mjs`),
   which also sets both version fields of `package-lock.json`. Nothing is
   committed.
3. npm records `gitHead` from `.git/HEAD` without checking for a clean tree
   (`@npmcli/package-json/lib/normalize.js:492-539`, npm 11.19.1);
   `npm view @torrent-tv/proxy@2.107.64 gitHead` = `2a3b3033…`, the released
   commit.
4. Every file under `.changeset/` that a pull request adds or changes must be a
   changeset: `isChangesetPath` = `^\.changeset/[a-z0-9][a-z0-9.-]*\.md$`
   (`scripts/lib.mjs:264`), and `check-changesets.mjs:11-17` /
   `changesetNotes` (`lib.mjs:307-320`) refuse any other path or any text that
   is not one or two `- **New|Fix|Chore**: …` bullets. `.changeset/README.md`
   fails the path rule; `.changeset/readme.md` fails the text rule.
5. The proxy repository allows rebase merges only; each pull request's commits
   land on `main` in one push, so one `main.yml` run plans one release.
6. Open pull requests #47 and #24 change `CHANGELOG.md`.

## Decisions

1. **No README in `.changeset/`** (Fact 4): it would fail the PR check and
   the first release. The format is explained in `AGENTS.md` "Changesets",
   and the frozen `CHANGELOG.md` line points there. Exempting a README needs a
   change in `torrent-tv/.github`, which step 2 does not make.
2. **Re-run guard on publication** (Fact 3): `npm view <pkg>@<version>
   gitHead` tells a re-run after a failed tag push (same commit: skip
   publication, tag) from a version published from another commit (fail, and
   name it).
3. **The add-on steps stay unchanged.** `addon-install-proxy` takes
   `version`/`bump`/`notes-file`, which `release-plan` gives with the same
   meaning; the notes are now the changeset bullets, the same `- **…**:`
   lines as the old `## Unreleased` section.
4. **`workflow_dispatch` `bump` is the least step**, not the step: it is
   raised to `minor` by a `feat` (`scripts/release-from-tags.mjs:46-49`). Its
   description says so.
5. **`.githooks/pre-push` is removed**: its only rule requires an
   `## Unreleased` entry, which the frozen changelog never gets, so it would
   refuse every local releasable push to `main`.

## Version at runtime

`0.0.0-development` is read in three places, all for display:

- `server.js:89-90` → `/health` and `/healthz` answer `{ ok, version }`
  (`routes/health/get.js:12`, `routes/healthz/get.js:12`);
- `bin/cli.js:45,545` → the start log line `Starting @torrent-tv/proxy v…`;
- `services/encode/OutputOpening.js:39,726` → the `transcode … start (proxy …)`
  log line.

Nothing compares the proxy's version: no test asserts it, no script under
`scripts/` reads it or `CHANGELOG.md`, the registry and tunnel handshake
(`services/transport/registry-api.js`, `tunnel-client.js`) send none
(`tunnel-client.js:209` sends a fixed `torrent-tv-proxy/1.0` User-Agent), and
the server and page (`torrent-tv/server`) never read the proxy's version
(`compareVersions` in `server/services/instance-role.js:49` compares two
*server* instances). The Docker image built in CI from source runs only
`--help`. The npm package and therefore the Home Assistant add-on get the real
version. A source checkout reports `0.0.0-development`, which is accurate.

## Release job

```yaml
  release:
    name: Release
    needs: [checks, build]
    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-26.04
    environment: production
    # Every release runs, one at a time, in the order the runs reach the queue. A later
    # run sees the earlier tag and releases what came after it; a run whose commit a
    # tag already holds only finishes what is missing.
    concurrency:
      group: release
      cancel-in-progress: false
      queue: max
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org

      # The version is the newest v* tag plus the step the commits ask for; it is
      # written into package.json and package-lock.json of this workspace only.
      - id: release
        uses: torrent-tv/.github/actions/release-plan@main
        with:
          version-files: package.json,package-lock.json
          bump: ${{ inputs.bump || 'auto' }}

      - name: Publish to npm
        if: steps.release.outputs.released == 'true' && steps.release.outputs.already != 'true'
        # npm trusted publishing (npmjs.com: torrent-tv/proxy, main.yml, environment
        # production) authenticates this step with the workflow's OIDC token; no npm
        # token is stored.
        env:
          VERSION: ${{ steps.release.outputs.version }}
        run: |
          npm install --global npm@11
          # A re-run after a publication whose tag push failed finds the version published
          # from this very commit (npm records it as gitHead) and only tags it.
          published=$(npm view "@torrent-tv/proxy@$VERSION" gitHead 2>/dev/null || true)
          if [ -z "$published" ]; then
            npm publish --provenance --access public
          elif [ "$published" = "$(git rev-parse HEAD)" ]; then
            echo "::notice::@torrent-tv/proxy@$VERSION is already published from this commit; only the tag is pushed"
          else
            echo "::error::@torrent-tv/proxy@$VERSION is published from $published but v$VERSION is not tagged; re-run the release of $published first"
            exit 1
          fi

      - if: steps.release.outputs.released == 'true'
        uses: torrent-tv/.github/actions/release-tag@main
        with:
          tag: ${{ steps.release.outputs.tag }}
          notes-file: ${{ steps.release.outputs.notes-file }}
          github-token: ${{ github.token }}

      # Unchanged until torrent-tv/meta#336 step 3 replaces them with a dispatch.
      - name: Token for the add-on only
        id: addon-token
        if: steps.release.outputs.released == 'true'
        uses: actions/create-github-app-token@v3
        with:
          client-id: ${{ vars.RELEASE_APP_CLIENT_ID }}
          private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
          owner: torrent-tv
          repositories: ha-addon
          permission-contents: write
          permission-actions: read

      - if: steps.release.outputs.released == 'true'
        uses: torrent-tv/.github/actions/addon-install-proxy@main
        with:
          github-token: ${{ steps.addon-token.outputs.token }}
          proxy-version: ${{ steps.release.outputs.version }}
          bump: ${{ steps.release.outputs.bump }}
          notes-file: ${{ steps.release.outputs.notes-file }}
          task: "#ttv-91"
```

Checks step, replacing `main.yml:84-88`:

```yaml
      - name: Pull request adds a changeset
        uses: torrent-tv/.github/actions/check-changesets@main
```

`workflow_dispatch` input, `main.yml:14-18`: `description: Least release step
(a feat still releases minor)`.

`dependencies.yml`, `update-dependencies` `with:`: `changeset: "true"`.
