#!/usr/bin/env bash
# The checks that need no secret: main.yml runs them one step each, so a run shows
# which one failed; dependencies.yml runs `all` on every commit it prepares.
#
#   bash scripts/check.sh tools | pins | install | guard | test | image
#   bash scripts/check.sh copies | changeset-format [<base> [<head>]]   (a pull request; main.yml)
#   bash scripts/check.sh changesets-selftest
#   bash scripts/check.sh all
#
# None of them starts a real torrent: `guard` refuses a check that could, and `test`
# loads test/no-torrent/support/refuse-torrent.cjs (AGENTS.md, "Checks").
set -euo pipefail
cd "$(dirname "$0")/.."

# Where the changesets live, and whether an empty one (`changeset add --empty`) is allowed.
CHANGESET_DIR=.changeset
CHANGESET_EMPTY_ALLOWED=no

# No step of this script waits for ever. Each one runs under `timeout`, which stops the
# command and its children and says so, and the exit status is 124. The limits are chosen
# (torrent-tv/meta#336): the run of 2026-11-10 took 74 s for the tests, 13 s for the install
# and 41 to 45 s for the image on a GitHub runner, and 39 s for the tests on a Mac. Without a limit
# a test that waited for an event that never came held `npm test` for 2 h 39 min.
INSTALL_LIMIT_SECONDS=900
TEST_LIMIT_SECONDS=900
IMAGE_LIMIT_SECONDS=1200

bound() {
  local seconds=$1 what=$2 status=0
  shift 2
  echo "$what: running, limit ${seconds}s"
  timeout -k 10 "$seconds" "$@" || status=$?
  if [ "$status" -eq 124 ]; then
    echo "::error::$what did not finish within ${seconds}s; it was stopped"
  fi
  return "$status"
}

tools() {
  # Security rule 6: Node (.node-version) and npm (packageManager) are exact versions,
  # and the runner provides exactly those. npm is the one bundled with that Node, and
  # npm trusted publishing needs npm 11.5.1 or later.
  local node_want npm_want
  node_want="v$(tr -d '[:space:]' < .node-version)"
  npm_want=$(node -p 'require("./package.json").packageManager.replace(/^npm@/, "")')
  if [ "$(node --version)" != "$node_want" ] || [ "$(npm --version)" != "$npm_want" ]; then
    echo "::error::node $(node --version) and npm $(npm --version) run here; the repository pins node $node_want and npm $npm_want"
    return 1
  fi
  echo "node $node_want and npm $npm_want"
}

pins() {
  # Security rule 6: no range and no `latest`, in dependencies, devDependencies,
  # optionalDependencies and overrides; an `npm:` alias names an exact version.
  node -e '
    const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
    const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
    const bad = [];
    const walk = (where, value) => {
      if (typeof value === "string") {
        const spec = value.startsWith("npm:") ? value.slice(value.lastIndexOf("@") + 1) : value;
        if (!exact.test(spec)) bad.push(where + " = " + value);
      } else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) walk(where + "." + key, inner);
      }
    };
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "overrides"]) walk(field, pkg[field]);
    if (bad.length) {
      console.error("::error::not an exact version: " + bad.join("; "));
      process.exit(1);
    }
    console.log("every dependency is pinned exactly");'
}

install() {
  # With the install scripts, which download and build the native modules; a passing
  # GitHub 504 fails them with no retry of their own (torrent-tv/meta#338). main.yml
  # runs its own install step, around a cache of those downloads.
  bound "$INSTALL_LIMIT_SECONDS" "npm ci with retries" node scripts/retry.mjs 3 20 npm ci --foreground-scripts
}

guard() {
  # The static half of "no check starts a real torrent".
  node scripts/check-tests-start-no-torrent.mjs
}

tests() {
  # `biome lint .` and the no-torrent tests (package.json "test"). The tests that read a
  # media file name FFPROBE_BIN, the system ffprobe.
  bound "$TEST_LIMIT_SECONDS" "lint and the no-torrent tests" npm test
}

image() {
  # The image checks itself in its last stage (`--help`): a build that succeeds loaded
  # every module and the native binding.
  bound "$IMAGE_LIMIT_SECONDS" "docker build" docker build -t torrent-tv-proxy .
}

# The checks on the changesets a pull request adds, and the proof that they fail on bad input
# (torrent-tv/meta#336). The rules are in torrent-tv/workflows CONTRIBUTING.md, "Versions and
# releases". This block is the same in proxy, server, ha-addon and infra; only CHANGESET_DIR and
# CHANGESET_EMPTY_ALLOWED, set at the top of the file, differ.

copies() {
  # copies <base> <head>: no commit of <base>..<head> is a copy of a commit anywhere in the
  # history of <base>. The release rewrites main: it replays each merged commit that added a
  # changeset, removes the changeset (the file is never in main's history) and keeps author, date
  # and subject. A branch cut from the old tip in the seconds before the rewrite still holds the
  # old commit; a plain rebase onto main keeps it, because its patch no longer equals the
  # rewritten one, and it adds the released changeset again. Comparing only with the commits
  # main gained since the branch point cannot see it once the branch sits on top of main, and a
  # path check cannot either, so the whole history of main is the reference. Author, author
  # date and subject survive both the rewrite and a rebase.
  local base=$1 head=$2 found
  found=$(LC_ALL=C comm -12 \
    <(git log --format='%ae %at %s' "$base..$head" | LC_ALL=C sort -u) \
    <(git log --format='%ae %at %s' "$base" | LC_ALL=C sort -u))
  if [ -n "$found" ]; then
    echo "::error::the pull request carries commits that main already holds under other hashes:"
    printf '%s\n' "$found"
    echo "Run: git fetch origin && git rebase --fork-point origin/main"
    return 1
  fi
  echo "no commit of the pull request is a copy of a commit on main"
}

changeset_files() {
  # The changeset notes (not README.md or config.json) that commit $1 adds.
  git diff-tree --no-commit-id --no-renames --name-only --diff-filter=A -r "$1" -- "$CHANGESET_DIR" |
    awk -v dir="$CHANGESET_DIR/" 'index($0, dir) == 1 && $0 ~ /\.md$/ && $0 != dir "README.md"'
}

changeset_problem() {
  # Reads one changeset file on stdin and prints what is wrong with it, or nothing. A changeset is
  # the front matter naming the package, then one plain sentence in one paragraph: no list marker,
  # heading, bold label, quote or code block. An empty one (`changeset add --empty`: no package, no
  # text) is allowed only where CHANGESET_EMPTY_ALLOWED is yes.
  awk -v empty_allowed="$CHANGESET_EMPTY_ALLOWED" '
    { sub(/\r$/, "") }
    state == 0 {
      if ($0 != "---") { print "it does not start with a --- front matter"; bad = 1; exit }
      state = 1; next
    }
    state == 1 {
      if ($0 == "---") { state = 2; next }
      if ($0 ~ /[^[:space:]]/) packages++
      next
    }
    $0 !~ /[^[:space:]]/ { if (lines > 0) gap = 1; next }
    gap { print "the text has more than one paragraph"; bad = 1; exit }
    $0 ~ /^[[:space:]]*([-*+>|]|#+|[0-9]+[.)])([[:space:]]|$)/ || $0 ~ /^[[:space:]]*(\*\*|__|```|~~~)/ || $0 ~ /^[[:space:]]*[*_]+[A-Za-z]+[*_]+:/ || $0 ~ /^(    |\t)/ {
      print "the text is not one plain sentence; this line starts like a list, heading, bold label, quote or code: " $0
      bad = 1; exit
    }
    { lines++ }
    END {
      if (bad) exit
      if (state < 2) print "the front matter is not closed"
      else if (lines == 0 && packages > 0) print "it names a package but has no sentence"
      else if (lines == 0 && empty_allowed != "yes") print "it is empty; a pull request adds one plain sentence"
      else if (lines > 0 && packages == 0) print "it has text but names no package, so it releases nothing"
    }'
}

changeset_format() {
  # changeset_format <base> <head>: every changeset a commit of <base>..<head> adds is one plain
  # sentence (changeset_problem). The label format `- **Fix**: ...` of the old changelogs reached
  # a release as `- - **Fix**: ...` (proxy 2.107.85).
  local base=$1 head=$2 status=0 commit file problem
  while read -r commit; do
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      problem=$(git show "$commit:$file" | changeset_problem)
      if [ -n "$problem" ]; then
        echo "::error file=$file::$file: $problem"
        status=1
      fi
    done < <(changeset_files "$commit")
  done < <(git log --reverse --format=%H "$base..$head")
  if [ "$status" -ne 0 ]; then
    echo "A changeset is the front matter naming the package with patch or minor, then one plain sentence a viewer understands."
  else
    echo "every changeset of the pull request is one plain sentence"
  fi
  return "$status"
}

changesets_selftest() (
  # Builds the cases the two checks exist for in a scratch repository and shows that each check
  # fails on the bad one and passes on the good one, so a check that stopped seeing them would
  # fail here. The copy case is the one measured on 2026-11-10 (proxy 2.107.82 and 2.107.83
  # released the same note): the release rewrote main inside the 22 s after a merge, a branch was
  # cut from the old tip, and a plain rebase put the old commit on top of the rewritten main.
  local scratch failures=0 base pre
  scratch=$(mktemp -d)
  trap 'rm -rf "$scratch"' EXIT
  isolate_git() {
    # Every variable that points git at a repository (`git rev-parse --local-env-vars`: GIT_DIR,
    # GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR, ...) is cleared, so that no object or ref of the
    # self-test reaches the repository that runs it. This runs before any other git command.
    unset $(git rev-parse --local-env-vars)
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_EDITOR=true \
      GIT_AUTHOR_NAME=selftest GIT_AUTHOR_EMAIL=selftest@example.com \
      GIT_COMMITTER_NAME=selftest GIT_COMMITTER_EMAIL=selftest@example.com
  }
  isolate_git

  expect() {
    # expect pass|fail <what> <command...>
    local want=$1 what=$2 status=0
    shift 2
    "$@" > "$scratch/out" 2>&1 || status=$?
    if { [ "$want" = pass ] && [ "$status" -eq 0 ]; } || { [ "$want" = fail ] && [ "$status" -ne 0 ]; }; then
      echo "ok: $what ($want)"
    else
      echo "::error::self-test: $what: expected $want, exit status $status"
      cat "$scratch/out"
      failures=$((failures + 1))
    fi
  }
  commit() {
    # commit <author date> <subject> [<committer date>]: commits what is staged.
    GIT_AUTHOR_DATE=$1 GIT_COMMITTER_DATE=${3:-$1} git commit -q -m "$2"
  }
  note() {
    # note <name> <text>: stages a changeset.
    printf -- '---\n"selftest": patch\n---\n\n%s\n' "$2" > "$CHANGESET_DIR/$1.md"
    git add "$CHANGESET_DIR/$1.md"
  }
  old_range_check() {
    # The check of 2.107.83: only the commits main gained since the branch point.
    [ -z "$(LC_ALL=C comm -12 \
      <(git log --format='%ae %at %s' "origin/main..HEAD" | LC_ALL=C sort) \
      <(git log --format='%ae %at %s' "HEAD..origin/main" | LC_ALL=C sort))" ]
  }
  accepts() {
    # accepts <file text>: changeset_problem finds nothing wrong.
    [ -z "$(printf '%b' "$1" | changeset_problem)" ]
  }

  mkdir "$scratch/repo"
  cd "$scratch/repo"
  git init -q -b main
  mkdir -p "$CHANGESET_DIR"
  printf '{}\n' > "$CHANGESET_DIR/config.json"
  printf '# Changesets\n' > "$CHANGESET_DIR/README.md"
  printf '# Changelog\n' > CHANGELOG.md
  git add -A
  commit 2026-11-10T20:00:00+00:00 "chore: start the repository"
  base=$(git rev-parse HEAD)
  # A pull request is merged: its commit adds a changeset (main before the version job ran).
  note open-faster "A film opens faster."
  commit 2026-11-10T21:00:00+00:00 "fix(open): open a film faster #ttv-1"
  pre=$(git rev-parse HEAD)
  # A test writer cuts its branch from that tip.
  git branch pr "$pre"
  # The version job rewrites main: the same commit, no changeset, the changelog entry instead.
  git checkout -q -b rewritten "$base"
  printf '## 1.0.1\n\n- A film opens faster.\n' >> CHANGELOG.md
  git add -A
  commit 2026-11-10T21:00:00+00:00 "fix(open): open a film faster #ttv-1" 2026-11-10T21:00:22+00:00
  git update-ref refs/remotes/origin/main HEAD
  # The branch gets its own commit, which adds the branch's own changeset, and is rebased.
  git checkout -q pr
  mkdir test
  printf 'test\n' > test/open.txt
  note open-fast-test "A film that opens fast is now tested."
  git add -A
  commit 2026-11-10T21:30:00+00:00 "test(open): a film opens fast #ttv-2"
  git branch pr-behind pr
  git rebase -q origin/main > /dev/null 2>&1 || true
  expect pass "the scenario holds the released changeset again on top of main" \
    test -f "$CHANGESET_DIR/open-faster.md"
  expect pass "main never added that changeset's path, so a path check cannot see the copy" \
    test -z "$(git log origin/main --diff-filter=A --format=%h -- "$CHANGESET_DIR/open-faster.md")"
  expect pass "the check of 2.107.83 passes the copy on top of main" old_range_check
  expect fail "a copy on top of main" copies origin/main HEAD
  expect fail "a copy on a branch behind main" copies origin/main pr-behind
  git checkout -q -b clean origin/main
  mkdir test
  printf 'test\n' > test/open.txt
  note open-fast-test "A film that opens fast is now tested."
  git add -A
  commit 2026-11-10T21:30:00+00:00 "test(open): a film opens fast #ttv-2"
  expect pass "a branch without a copy" copies origin/main HEAD

  # The format of what a pull request adds.
  local front='---\n"selftest": patch\n---\n\n'
  expect pass "one plain sentence" accepts "${front}A film opens faster.\n"
  expect pass "one sentence wrapped over two lines" accepts "${front}A film that the proxy\ncopies opens faster.\n"
  expect pass "a minor changeset" accepts '---\n"selftest": minor\n---\n\nA film opens faster.\n'
  expect fail "a label and a bullet" accepts "${front}- **Fix**: A film opens faster.\n"
  expect fail "a bullet" accepts "${front}- A film opens faster.\n"
  expect fail "a star bullet" accepts "${front}* A film opens faster.\n"
  expect fail "a numbered item" accepts "${front}1. A film opens faster.\n"
  expect fail "a bold label" accepts "${front}**Fix**: A film opens faster.\n"
  expect fail "a heading" accepts "${front}# A film opens faster\n"
  expect fail "a quote" accepts "${front}> A film opens faster.\n"
  expect fail "a code block" accepts "${front}\`\`\`\nA film opens faster.\n\`\`\`\n"
  expect fail "a tilde code block" accepts "${front}~~~\nA film opens faster.\n~~~\n"
  expect fail "an italic label" accepts "${front}*Fix*: A film opens faster.\n"
  expect fail "an underscore label" accepts "${front}_Fix_: A film opens faster.\n"
  expect pass "a sentence that starts with a number and a unit" accepts "${front}2 films now open faster.\n"
  expect fail "two paragraphs" accepts "${front}A film opens faster.\n\nA film starts sooner.\n"
  expect fail "a package and no sentence" accepts "${front}"
  expect fail "no front matter" accepts "A film opens faster.\n"
  expect fail "a front matter that is not closed" accepts '---\n"selftest": patch\n'
  expect fail "a sentence and no package" accepts '---\n---\n\nA film opens faster.\n'
  CHANGESET_EMPTY_ALLOWED=yes expect pass "an empty changeset where it is allowed" accepts '---\n---\n\n'
  CHANGESET_EMPTY_ALLOWED=yes expect pass "an empty changeset as changeset add --empty writes it" accepts '---\n\n---\n\n\n'
  CHANGESET_EMPTY_ALLOWED=no expect fail "an empty changeset where it is not allowed" accepts '---\n---\n\n'

  git checkout -q -b bad-format origin/main
  printf -- '---\n"selftest": patch\n---\n\n- **Fix**: A film opens faster.\n' > "$CHANGESET_DIR/old-label.md"
  git add -A
  commit 2026-11-10T21:40:00+00:00 "fix(open): an old label #ttv-3"
  expect fail "the changeset check on a pull request with the old label" changeset_format origin/main HEAD
  git checkout -q -b good-format origin/main
  note one-sentence "A film opens faster."
  commit 2026-11-10T21:41:00+00:00 "fix(open): one sentence #ttv-3"
  expect pass "the changeset check on a pull request with one sentence" changeset_format origin/main HEAD

  # The self-test writes nothing into a repository that the environment points git at.
  git init -q "$scratch/foreign"
  git -C "$scratch/foreign" -c user.name=x -c user.email=x@example.com commit -q --allow-empty -m foreign
  foreign_state() { { find "$scratch/foreign/.git/objects" -type f | sort; git -C "$scratch/foreign" for-each-ref; } | cksum; }
  local before
  before=$(foreign_state)
  (
    export GIT_DIR="$scratch/foreign/.git" GIT_OBJECT_DIRECTORY="$scratch/foreign/.git/objects" \
      GIT_COMMON_DIR="$scratch/foreign/.git" GIT_INDEX_FILE="$scratch/foreign/.git/index"
    isolate_git
    mkdir "$scratch/probe"
    cd "$scratch/probe"
    git init -q
    printf 'probe\n' > probe.txt
    git add probe.txt
    commit 2026-11-10T22:00:00+00:00 "chore: probe"
  )
  expect pass "a repository named by GIT_OBJECT_DIRECTORY and GIT_COMMON_DIR is left unchanged" \
    test "$(foreign_state)" = "$before"
  expect pass "the probe commit went into its own repository" \
    test -n "$(git -C "$scratch/probe" log --format=%h)"

  [ "$failures" -eq 0 ]
)

case "${1:-}" in
  tools) tools ;;
  pins) pins ;;
  install) install ;;
  guard) guard ;;
  test) tests ;;
  image) image ;;
  copies) copies "${2:-origin/main}" "${3:-HEAD}" ;;
  changeset-format) changeset_format "${2:-origin/main}" "${3:-HEAD}" ;;
  changesets-selftest) changesets_selftest ;;
  all) tools && pins && install && guard && tests && image ;;
  *) echo "usage: bash scripts/check.sh tools|pins|install|guard|test|image|copies [<base> [<head>]]|changeset-format [<base> [<head>]]|changesets-selftest|all" >&2; exit 2 ;;
esac
