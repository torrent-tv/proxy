#!/usr/bin/env bash
# The checks that need no secret: main.yml runs them one step each, so a run shows
# which one failed; dependencies.yml runs `all` on every commit it prepares.
#
#   bash scripts/check.sh tools | pins | install | guard | test | image
#   bash scripts/check.sh copies | changeset-format [<base> [<head>]]   (a pull request; main.yml)
#   bash scripts/check.sh changesets-selftest
#   bash scripts/check.sh workflow-pins | workflow-tokens | commit-msg-bot [<dir or file>]
#   bash scripts/check.sh workflow-selftest
#   bash scripts/check.sh all
#
# None of them starts a real torrent: `guard` refuses a check that could, and `test`
# loads test/no-torrent/support/refuse-torrent.cjs (AGENTS.md, "Checks").
set -euo pipefail
cd "$(dirname "$0")/.."

# Where the changesets live, and whether an empty one (`changeset add --empty`) is allowed.
CHANGESET_DIR=.changeset
CHANGESET_EMPTY_ALLOWED=no

# The checks of the workflow files (the block "The checks of the workflow files" below is the same in
# every repository; this is what differs). WORKFLOW_PUSHES has one row for each job that pushes a tag, a
# branch or a commit, or creates a release: <file>|<job>|<id of its actions/create-github-app-token step,
# or github>|<the permission-* inputs of that token, or the `permissions` of the job for github>.
# GitHub refuses a push of a commit that changes a workflow file unless the token has `workflows`;
# GITHUB_TOKEN never has it (torrent-tv/meta#336, run 42919325834).
WORKFLOW_PUSHES='
main.yml|version|token|contents:write workflows:write
main.yml|publish|token|contents:write workflows:write
main.yml|rebase-prs|token|contents:write pull-requests:write workflows:write
dependencies.yml|push|token|contents:write
'
# The steps of the job `update` of dependencies.yml that hold a token. The job runs the install scripts and
# tests of packages it has just resolved, so each such step reads public data only and no other step
# holds one (torrent-tv/meta#424).
DEPENDENCY_TOKEN_STEPS='Raise the packages that Dependabot alerts name'
# The directory the dependency job's steps run in, from the root of the repository.
DEPENDENCY_WORKDIR=.

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

# Helpers of the self-tests of every check below. isolate_git clears every variable that points git at a
# repository (`git rev-parse --local-env-vars`: GIT_DIR, GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR, ...), so that
# no object or ref of a self-test reaches the repository that runs it; it runs before any other git command
# of a self-test. expect runs a command and compares its exit status with what the case wants; the self-test
# that calls it declares `scratch` (a directory) and `failures` (a counter).
isolate_git() {
  unset $(git rev-parse --local-env-vars)
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_EDITOR=true \
    GIT_AUTHOR_NAME=selftest GIT_AUTHOR_EMAIL=selftest@example.com \
    GIT_COMMITTER_NAME=selftest GIT_COMMITTER_EMAIL=selftest@example.com
}

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
  isolate_git
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

YQ_VERSION=4.54.1

# The checks of the workflow files in .github/workflows, and the proof that they fail on bad input
# (torrent-tv/meta#336, lessons meta#423, meta#424, meta#425 and the one on the token of a job that
# pushes). The rules are in AGENTS.md ("Security" rule 6) and in torrent-tv/workflows
# CONTRIBUTING.md ("Versions and releases"). This block is the same in proxy, server, ha-addon and
# infra; only WORKFLOW_PUSHES, DEPENDENCY_TOKEN_STEPS and DEPENDENCY_WORKDIR, set at the top of the
# file, differ.

yq_pinned() {
  # The runner image provides yq; the version is the one server's `install` job checks. A different
  # version fails here, before any file is read, and changes only in a commit (Security rule 6).
  local want="yq (https://github.com/mikefarah/yq/) version v$YQ_VERSION" have
  have=$(yq --version 2>/dev/null) || { echo "::error::yq $YQ_VERSION is not installed"; return 1; }
  if [ "$have" != "$want" ]; then
    echo "::error::yq is not $YQ_VERSION: $have"
    return 1
  fi
}

workflow_pins() {
  # workflow_pins [<dir>]: every version a workflow takes from outside is an exact one (Security
  # rule 6), so a run is the same run tomorrow. The files are read line by line, with no YAML
  # library. A `uses:` is `owner/repo[/path]@vX.Y.Z`, `...@<40 hex>`, `docker://image:X.Y.Z`,
  # `docker://image@sha256:<64 hex>` or `./path`; `node-version:` is never written (only
  # `node-version-file:`); a docker/setup-buildx-action step names the BuildKit image
  # (`driver-opts: image=moby/buildkit:vX.Y.Z`) or `driver: docker`; in a `run:` an npm install,
  # an `npx` and a docker pull or run name `name@X.Y.Z` or an image with `:X.Y.Z` or a digest. A
  # version in a shell variable is accepted where the same `run:` proves the variable is X.Y.Z with
  # `[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]`. `npx --no-install` installs nothing, and writing a tag
  # (`imagetools create --tag ...:latest`) is not an install.
  WORKFLOW_DIR=${1:-.github/workflows} node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const dir = process.env.WORKFLOW_DIR;
const exact = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const usesOk = new RegExp(
  `^(?:\\./\\S*|[\\w.-]+/[\\w.-]+(?:/[\\w./-]+)?@(?:v${exact}|[0-9a-f]{40})|docker://[^\\s:@]+:${exact}|docker://[^\\s:@]+@sha256:[0-9a-f]{64})$`,
);
const npmSpecOk = new RegExp(`^(?:@[\\w.-]+/)?[\\w.-]+@${exact}$`);
const npmSpecVariable = /^(?:@[\w.-]+\/)?[\w.-]+@\$\{?(\w+)\}?$/;
const imageOk = new RegExp(`^[^\\s@]+:${exact}(?:@sha256:[0-9a-f]{64})?$|^[^\\s@:]+@sha256:[0-9a-f]{64}$`);

const escapeData = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
let failures = 0;
let looked = 0;
const refuse = (file, line, reason) => {
  failures += 1;
  const where = path.join(dir, file);
  console.log(`::error file=${escapeProperty(where)},line=${line}::${escapeData(`${where}:${line}: ${reason}`)}`);
};

const indentOf = (line) => line.length - line.trimStart().length;
const blank = (line) => line.trim() === "" || line.trim().startsWith("#");
const unquote = (token) => token.replace(/^["']|["']$/g, "");
const valueOptions = new Set([
  "--prefix", "--workspace", "-w", "--registry", "--tag", "--cache", "--userconfig", "--loglevel",
  "--omit", "--include", "--install-strategy", "--otp", "--scope", "--before", "--lockfile-version",
  "-v", "--volume", "-e", "--env", "--env-file", "-w", "--workdir", "-u", "--user", "-p", "--publish",
  "--name", "--network", "--entrypoint", "--mount", "--platform", "-l", "--label", "--cpus", "-m",
  "--memory", "--add-host", "--cap-add", "--device",
]);

// The run blocks of a file: `run: cmd` is one line, `run: |` is the lines indented below it.
const runBlocks = (lines) => {
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)(-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const keyColumn = match[1].length + (match[2] ? match[2].length : 0);
    if (/^[|>][+-]?\d*\s*(#.*)?$/.test(match[3])) {
      const body = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > keyColumn)) {
        body.push({ number: j + 1, text: lines[j] });
        j += 1;
      }
      blocks.push(body);
      i = j - 1;
    } else {
      blocks.push([{ number: i + 1, text: match[3] }]);
    }
  }
  return blocks;
};

const prefixWords = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "sudo", "exec", "time", "command", "env", "nohup", "{"]);

// The first words of each simple command of a shell line, after what only prefixes it.
const commandsOf = (line) =>
  line
    .split(/&&|\|\||;|\||\(|\)|`/)
    .map((segment) => {
      const words = segment.trim().split(/\s+/).filter(Boolean);
      let i = 0;
      while (i < words.length && (prefixWords.has(words[i]) || /^[A-Za-z_]\w*=/.test(words[i]))) i += 1;
      if (words[i] === "timeout") {
        i += 1;
        while (i < words.length && words[i].startsWith("-")) i += 1;
        i += 1;
      }
      return words.slice(i);
    })
    .filter((words) => words.length > 0);

const positionals = (tokens) => {
  const found = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const token = unquote(tokens[k]);
    if (token === "--") {
      found.push(...tokens.slice(k + 1).map(unquote));
      break;
    }
    if (valueOptions.has(token)) {
      k += 1;
    } else if (!token.startsWith("-")) {
      found.push(token);
    }
  }
  return found;
};

const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort() : [];
if (files.length === 0) {
  console.log(`::error::${escapeData(dir)} holds no workflow file`);
  process.exit(1);
}

for (const file of files) {
  const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
  looked += 1;

  lines.forEach((text, index) => {
    if (blank(text)) return;
    const number = index + 1;
    const uses = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(text);
    if (uses) {
      const value = unquote(uses[1]);
      if (!usesOk.test(value)) {
        refuse(file, number, `uses: ${value} is not owner/repo@vX.Y.Z, @<40 hex>, docker://image:X.Y.Z, a digest or ./path`);
      }
      if (/^docker\/setup-buildx-action@/.test(value)) {
        const keyColumn = indentOf(text) + (/^\s*-\s/.test(text) ? 2 : 0);
        let start = index;
        if (!/^\s*-\s/.test(text)) {
          while (start > 0 && (blank(lines[start - 1]) || indentOf(lines[start - 1]) >= keyColumn)) start -= 1;
          if (start > 0 && /^\s*-\s/.test(lines[start - 1])) start -= 1;
        }
        let end = index;
        while (end + 1 < lines.length && (blank(lines[end + 1]) || indentOf(lines[end + 1]) >= keyColumn)) end += 1;
        const step = lines.slice(start, end + 1).filter((entry) => !entry.trim().startsWith("#")).join("\n");
        const pinned = /driver-opts:[\s\S]*image=moby\/buildkit:v\d+\.\d+\.\d+/.test(step) || /^\s*driver:\s*docker\s*$/m.test(step);
        if (!pinned) {
          refuse(file, number, "docker/setup-buildx-action starts BuildKit from a moving tag; set driver-opts: image=moby/buildkit:vX.Y.Z");
        }
      }
    }
    if (/^\s*(?:-\s+)?node-version:/.test(text)) {
      refuse(file, number, "node-version is a literal; write node-version-file: .node-version");
    }
  });

  for (const block of runBlocks(lines)) {
    const whole = block.map((entry) => entry.text).join("\n");
    const variableProved = (name) =>
      new RegExp(String.raw`\[\[[^\]]*\$\{?${name}\}?[^\]]*=~\s*\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$`).test(whole);
    const specRefusal = (spec) => {
      if (spec === "." || spec.startsWith("./") || spec.startsWith("../")) return "";
      if (npmSpecOk.test(spec)) return "";
      const variable = npmSpecVariable.exec(spec);
      if (variable && variableProved(variable[1])) return "";
      return `"${spec}", which is not name@X.Y.Z`;
    };
    for (const entry of block) {
      if (blank(entry.text)) continue;
      for (const words of commandsOf(entry.text)) {
        const [command, ...args] = words;
        if (command === "npm") {
          const sub = args.find((arg) => !arg.startsWith("-"));
          const rest = args.slice(args.indexOf(sub) + 1);
          if (["install", "i", "add", "in", "ins", "inst", "insta", "instal", "isntall", "install-test", "it"].includes(sub)) {
            for (const spec of positionals(rest)) {
              const problem = specRefusal(spec);
              if (problem) refuse(file, entry.number, `npm ${sub} installs ${problem}`);
            }
          } else if (["exec", "x"].includes(sub)) {
            words.splice(0, args.indexOf(sub) + 2, "npx");
          }
        }
        if (words[0] === "npx") {
          const rest = words.slice(1);
          if (rest.includes("--no-install") || rest.includes("--no")) continue;
          // With -p or --package the packages are named there, and the first word after the options is the
          // command to run, not a package.
          let packaged = false;
          for (let k = 0; k < rest.length; k += 1) {
            const token = unquote(rest[k]);
            if (token === "-p" || token === "--package") {
              const problem = specRefusal(unquote(rest[k + 1] ?? ""));
              if (problem) refuse(file, entry.number, `npx installs ${problem}`);
              packaged = true;
              k += 1;
            } else if (token.startsWith("--package=")) {
              const problem = specRefusal(token.slice("--package=".length));
              if (problem) refuse(file, entry.number, `npx installs ${problem}`);
              packaged = true;
            } else if (!token.startsWith("-")) {
              const problem = packaged ? "" : specRefusal(token);
              if (problem) refuse(file, entry.number, `npx installs ${problem}; use npx --no-install for a locked package`);
              break;
            }
          }
        }
        if (command === "docker" && ["pull", "run", "create"].includes(args[0])) {
          const [image] = positionals(args.slice(1));
          if (image && !imageOk.test(image)) {
            refuse(file, entry.number, `docker ${args[0]} names "${image}", which is not image:X.Y.Z or a digest`);
          }
        }
      }
    }
  }
}

if (failures > 0) process.exit(1);
console.log(`workflow tools are exact versions: ${looked} workflow file(s) read`);
NODE
}

workflow_tokens() {
  # workflow_tokens [<dir> [<root>]]: which job holds which token (torrent-tv/meta#424 and the push of a tag
  # by a job whose token cannot change a workflow file, torrent-tv/meta#336). The files are read by
  # yq (YQ_VERSION), turned into JSON, and judged by node.
  #  1. dependencies.yml, job `update`: it runs the install scripts and tests of packages it has just
  #     resolved, so no token is in its `env`, in a `with`, or kept by a checkout (persist-credentials:
  #     false); the steps that hold one are exactly DEPENDENCY_TOKEN_STEPS, each reading public data.
  #  2. Every job that pushes a tag, a branch or a commit, or creates a release, is a row of
  #     WORKFLOW_PUSHES with the token it pushes with. A job pushes when a `run:` has `git push`
  #     (also `git -C <dir> push`; a quote or a backtick may come before `git`, so `echo "git push"`
  #     counts, which fails safe), `gh release create`, `changeset git-tag` or a `gh api` write
  #     (-X POST|PATCH|PUT|DELETE, or -f/-F fields) to a git, contents, merges, releases or branches
  #     endpoint, or calls a script (`node|bash|sh <path>` under <root>, the repository root, `.` by
  #     default) whose text pushes (`git push`, `git("push"`, `["git", ..., "push"]`). The one script
  #     that is not read is scripts/check.sh, which holds these patterns as data; a script that a script
  #     calls is not followed. An App token holds exactly the permission-* inputs of its row, its
  #     checkout uses it, every `gh` step reads it, and nothing names the plain GITHUB_TOKEN.
  #     GitHub refuses a push of a commit that changes a workflow file unless the token has the
  #     `workflows` permission, which GITHUB_TOKEN can never have (run 42919325834: tag v0.66.58 was
  #     refused for such a commit). A row whose token is `github` lists the job's own `permissions`.
  local dir=${1:-.github/workflows} root=${2:-.} json file status=0
  yq_pinned || return 1
  json=$(mktemp -d)
  for file in "$dir"/*.yml "$dir"/*.yaml; do
    [ -e "$file" ] || continue
    if ! yq -o=json '.' "$file" > "$json/$(basename "$file").json"; then
      echo "::error::yq cannot read $file"
      rm -rf "$json"
      return 1
    fi
  done
  WORKFLOW_JSON=$json WORKFLOW_PATH=$dir WORKFLOW_ROOT=$root WORKFLOW_PUSHES=$WORKFLOW_PUSHES DEPENDENCY_TOKEN_STEPS=$DEPENDENCY_TOKEN_STEPS node - <<'NODE' || status=$?
const fs = require("node:fs");
const path = require("node:path");

const jsonDir = process.env.WORKFLOW_JSON;
const shown = process.env.WORKFLOW_PATH;
const escapeData = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
let failures = 0;
const refuse = (file, message) => {
  failures += 1;
  console.log(`::error file=${escapeProperty(path.join(shown, file))}::${escapeData(`${file}: ${message}`)}`);
};
const read = (file) => {
  const found = path.join(jsonDir, `${file}.json`);
  return fs.existsSync(found) ? JSON.parse(fs.readFileSync(found, "utf8")) : null;
};
const table = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const rows = table(process.env.WORKFLOW_PUSHES).map((line) => {
  const [file, job, token, permissions] = line.split("|").map((part) => part.trim());
  return { file, job, token, permissions: permissions.split(/\s+/).filter(Boolean).sort() };
});
const allowedSteps = new Set(table(process.env.DEPENDENCY_TOKEN_STEPS));

const holdsToken = (value) => /github\.token|secrets\.|GITHUB_TOKEN|outputs\.token/.test(typeof value === "string" ? value : JSON.stringify(value ?? ""));
const plainToken = (value) => /github\.token|secrets\.GITHUB_TOKEN/.test(typeof value === "string" ? value : JSON.stringify(value ?? ""));
const stepsOf = (job) => (Array.isArray(job?.steps) ? job.steps : []);
const label = (step, index) => step.name ?? step.id ?? `step ${index + 1}`;
const root = path.resolve(process.env.WORKFLOW_ROOT);
// The commands of a step, without comment lines, a line continued by a backslash joined to the next.
const code = (step) => String(step.run ?? "").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n").replace(/\\\n\s*/g, " ");
const PUSH = /(?:^|[\s;&|("'`])(?:git(?:\s+-[Cc]\s+\S+)*\s+push|gh\s+release\s+create|changeset\s+git-tag)(?:\s|$)/m;
const API_WRITE = /(?:^|[\s;&|(])gh\s+api\b(?=[^\n]*(?:(?:-X|--method)[\s=]+(?:POST|PATCH|PUT|DELETE)\b|\s(?:-f|-F|--field|--raw-field|--input)\b))[^\n]*\/(?:git\/|contents\/|merges|releases|branches)/m;
const SCRIPT_PUSH = [PUSH, /(?:^|[^\w$.])git\(\s*["']push["']/, /["']git["']\s*,\s*\[(?:\s*["'][^"']*["']\s*,)*\s*["']push["']/];
const SCRIPT_CALL = /(?:^|[\s;&|(])(?:node|bash|sh)\s+["']?(?:\$\{?GITHUB_WORKSPACE\}?\/)?([\w./-]+\.(?:mjs|cjs|js|sh))/gm;
const scriptPushes = (step) =>
  [...code(step).matchAll(SCRIPT_CALL)].some((call) => {
    const file = path.resolve(root, call[1]);
    if (call[1] === "scripts/check.sh" || !file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file)) return false;
    const text = fs.readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*(#|\/\/)/.test(line)).join("\n");
    return SCRIPT_PUSH.some((pattern) => pattern.test(text));
  });
const pushesStep = (step) => PUSH.test(code(step)) || API_WRITE.test(code(step)) || scriptPushes(step);
const GH = /(?:^|[\s;&|(])gh\s+(?:release|pr|api|workflow|run|repo|issue|label)(?:\s|$)/m;

// 1. The job that runs package code holds no token.
const dependencies = read("dependencies.yml");
if (!dependencies) {
  refuse("dependencies.yml", "the file is missing");
} else if (!dependencies.jobs?.update) {
  refuse("dependencies.yml", "it has no job named update");
} else {
  const update = dependencies.jobs.update;
  if (holdsToken(dependencies.env)) refuse("dependencies.yml", "the workflow env has a token");
  for (const [key, value] of Object.entries(update.env ?? {})) {
    if (holdsToken(value)) refuse("dependencies.yml", `job update has a token: env ${key}`);
  }
  const holders = [];
  stepsOf(update).forEach((step, index) => {
    const named = [...Object.entries(step.env ?? {}), ...Object.entries(step.with ?? {})];
    if (named.some(([key, value]) => /^(GH_TOKEN|GITHUB_TOKEN)$/.test(key) || holdsToken(value))) holders.push(label(step, index));
    if (/^actions\/checkout@/.test(step.uses ?? "") && step.with?.["persist-credentials"] !== false) {
      refuse("dependencies.yml", `step "${label(step, index)}" keeps the checkout token in .git/config; set persist-credentials: false`);
    }
  });
  for (const holder of holders) {
    if (!allowedSteps.has(holder)) refuse("dependencies.yml", `step "${holder}" has a token`);
  }
  for (const allowed of allowedSteps) {
    if (!holders.includes(allowed)) refuse("dependencies.yml", `step "${allowed}" is on the list of steps that hold a token but holds none; change the list`);
  }
}

// 2. Every job that pushes holds the token it needs.
for (const name of fs.readdirSync(jsonDir).map((entry) => entry.replace(/\.json$/, "")).sort()) {
  for (const [jobName, job] of Object.entries(read(name).jobs ?? {})) {
    const pushes = stepsOf(job).some(pushesStep);
    if (pushes && !rows.some((row) => row.file === name && row.job === jobName)) {
      refuse(name, `job ${jobName} pushes (a tag, a branch or a commit, a release, a ref by the API, or through a script), and WORKFLOW_PUSHES in scripts/check.sh does not say which token it needs`);
    }
  }
}
for (const row of rows) {
  const workflow = read(row.file);
  const job = workflow?.jobs?.[row.job];
  if (!job) {
    refuse(row.file, `WORKFLOW_PUSHES names job ${row.job}, which does not exist`);
    continue;
  }
  const where = `job ${row.job}`;
  if (plainToken(workflow.env) || plainToken(job.env)) refuse(row.file, `${where} puts the plain GITHUB_TOKEN in its env`);
  if (row.token === "github") {
    const have = Object.entries(job.permissions ?? {}).map(([key, value]) => `${key}:${value}`).sort();
    if (have.join(" ") !== row.permissions.join(" ")) {
      refuse(row.file, `${where} pushes with the GITHUB_TOKEN and its permissions are [${have.join(" ")}], not [${row.permissions.join(" ")}]`);
    }
    continue;
  }
  const steps = stepsOf(job);
  const tokenStep = steps.find((step) => step.id === row.token && /^actions\/create-github-app-token@/.test(step.uses ?? ""));
  if (!tokenStep) {
    refuse(row.file, `${where} has no actions/create-github-app-token step with id ${row.token}, and it pushes`);
    continue;
  }
  const have = Object.entries(tokenStep.with ?? {})
    .filter(([key]) => key.startsWith("permission-"))
    .map(([key, value]) => `${key.slice("permission-".length)}:${value}`)
    .sort();
  if (have.join(" ") !== row.permissions.join(" ")) {
    refuse(row.file, `${where} pushes and needs the permissions [${row.permissions.join(" ")}], but its App token has [${have.join(" ")}]`);
  }
  const appTokens = new Set(steps.filter((step) => /^actions\/create-github-app-token@/.test(step.uses ?? "") && step.id).map((step) => `\${{ steps.${step.id}.outputs.token }}`));
  const own = `\${{ steps.${row.token}.outputs.token }}`;
  steps.forEach((step, index) => {
    const name = label(step, index);
    if (/^actions\/checkout@/.test(step.uses ?? "") && step.with?.token !== own) {
      refuse(row.file, `${where}: checkout step "${name}" does not use the App token, so a push would use the plain GITHUB_TOKEN`);
    }
    for (const [key, value] of Object.entries(step.env ?? {})) {
      if (plainToken(value)) refuse(row.file, `${where}: step "${name}" env ${key} is the plain GITHUB_TOKEN`);
    }
    if (/GITHUB_TOKEN|github\.token/.test(code(step))) refuse(row.file, `${where}: step "${name}" writes the plain GITHUB_TOKEN in its script`);
    if (GH.test(code(step)) && !appTokens.has(step.env?.GH_TOKEN)) {
      refuse(row.file, `${where}: step "${name}" runs gh and its GH_TOKEN is ${step.env?.GH_TOKEN ?? "not set"}, not an App token of this job`);
    }
  });
}

if (failures > 0) process.exit(1);
console.log(`workflow tokens: the dependency job gives none to package code; ${rows.length} pushing job(s) hold the token they need`);
NODE
  rm -rf "$json"
  return "$status"
}

commit_msg_bot() (
  # commit_msg_bot [<dependencies.yml>]: the step "Test every commit, oldest first" of the
  # dependency workflow refuses a commit it prepared whose message the repository's commit-msg hook
  # refuses, and stops there (torrent-tv/meta#425: a 120-character body line was refused by commitlint
  # only after the push to main). The step is taken from the file, with its helper `commit`, and run in
  # a scratch repository on three commits, with a stub npm and a stub scripts/check.sh that succeed.
  local file=${1:-.github/workflows/dependencies.yml} root scratch failures=0
  local step='.jobs.update.steps[] | select(.name == "Test every commit, oldest first") | .run'
  local helpers='.jobs.update.steps[] | select(.name == "Record the base and the helpers") | .run'
  yq_pinned || return 1
  root=$PWD
  scratch=$(mktemp -d)
  trap 'rm -rf "$scratch"' EXIT
  yq "$step" "$file" > "$scratch/loop.sh"
  yq "$helpers" "$file" | awk "/<<'LIB'/ { on = 1; next } /^LIB\$/ { on = 0 } on" > "$scratch/lib.sh"
  if [ ! -s "$scratch/loop.sh" ] || [ "$(cat "$scratch/loop.sh")" = null ] || [ ! -s "$scratch/lib.sh" ]; then
    echo "::error::$file has no step \"Test every commit, oldest first\" or no helper \`commit\` to run it with"
    return 1
  fi
  mkdir -p "$scratch/workspace/.githooks" "$scratch/workspace/scripts" "$scratch/workspace/$DEPENDENCY_WORKDIR/.changeset" "$scratch/bin" "$scratch/tmp"
  cp "$root/.githooks/commit-msg" "$scratch/workspace/.githooks/commit-msg"
  printf '#!/bin/sh\nexit 0\n' > "$scratch/bin/npm"
  printf 'exit 0\n' > "$scratch/workspace/scripts/check.sh"
  chmod +x "$scratch/bin/npm"
  isolate_git
  cd "$scratch/workspace"
  git init -q -b main
  cd "$DEPENDENCY_WORKDIR"
  printf '{"name":"scratch"}\n' > package.json
  printf '{}\n' > package-lock.json
  printf '{}\n' > .changeset/config.json
  printf 'services: {}\n' > docker-compose.yml
  git add -A
  git commit -q --no-verify -m "chore: start the repository #ttv-1"
  local base good_one bad_one good_two body
  base=$(git rev-parse HEAD)

  prepare() {
    # prepare <number> <header>: a commit made by the helper `commit` of the workflow, with a long
    # body that it folds.
    printf '{"name":"scratch","n":%s}\n' "$1" > package.json
    body=$(for i in $(seq 1 60); do printf 'package-%s 1.0.0 -> 1.0.1, ' "$i"; done)
    ( . "$scratch/lib.sh" && commit "$2" "$body" > /dev/null )
  }
  prepare 1 "fix(deps): fix an alert #ttv-386"
  good_one=$(git rev-parse HEAD)
  printf '{"name":"scratch","n":2}\n' > package.json
  git add -A
  git commit -q --no-verify -m "fix(deps): update dependencies #ttv-386" -m "$(printf 'a%.0s' $(seq 1 120))"
  bad_one=$(git rev-parse HEAD)
  prepare 3 "chore(deps): update the lock file #ttv-386"
  git branch with-refused-message
  git checkout -q -b all-pass "$good_one"
  prepare 4 "chore(deps): update the lock file #ttv-386"
  good_two=$(git rev-parse HEAD)

  run_loop() {
    # run_loop <branch>: the step on the commits of <branch> after the base, in the directory it runs in.
    git switch -q "$1"
    : > "$scratch/tmp/failed.txt"
    rm -f "$scratch/tmp/good"
    BASE=$base RUNNER_TEMP=$scratch/tmp GITHUB_WORKSPACE=$scratch/workspace PATH=$scratch/bin:$PATH \
      bash "$scratch/loop.sh"
  }
  expect pass "the step runs on a branch of three commits" run_loop with-refused-message
  cp "$scratch/out" "$scratch/loop.out"
  expect pass "it keeps the commit before the one whose body line is 120 characters long" \
    test "$(cat "$scratch/tmp/good")" = "$good_one"
  expect pass "it says which header was refused" \
    grep -qxF "commit message rejected on $(git log -1 --format=%s "$bad_one")" "$scratch/tmp/failed.txt"
  expect pass "it prints the error of that commit" grep -q '^::error::the commit message of "fix(deps): update dependencies #ttv-386" is refused' "$scratch/loop.out"
  expect pass "the step runs on commits made by the helper" run_loop all-pass
  expect pass "a commit made by the helper, with a folded body, passes the hook and the loop reaches the tip" \
    test "$(cat "$scratch/tmp/good")" = "$good_two"
  expect pass "nothing was recorded as failed" test ! -s "$scratch/tmp/failed.txt"
  [ "$failures" -eq 0 ] && echo "the dependency job refuses a commit message the hook refuses"
)

workflow_selftest() (
  # Builds each case the three checks exist for and shows that the check fails on the bad one and
  # passes on the good one, so a check that stopped seeing them would fail here. The bad inputs of
  # workflow_pins are the forms measured in torrent-tv/meta#423; those of workflow_tokens are a copy of
  # this repository's workflow files changed back to the state before torrent-tv/meta#424 and
  # before the tag push of 2026-11-10; the bad input of commit_msg_bot is the loop without the hook.
  local scratch failures=0 case_number=0
  scratch=$(mktemp -d)
  trap 'rm -rf "$scratch"' EXIT
  isolate_git

  pins_case() {
    # pins_case pass|fail <what> <yaml lines of one step or one job>: a workflow file of its own.
    local want=$1 what=$2
    case_number=$((case_number + 1))
    mkdir "$scratch/pins-$case_number"
    printf 'name: Case\non: push\njobs:\n  case:\n    runs-on: ubuntu-26.04\n    steps:\n%s\n' "$3" > "$scratch/pins-$case_number/case.yml"
    expect "$want" "workflow-pins: $what" workflow_pins "$scratch/pins-$case_number"
  }
  pins_case fail "an action at a major version" '      - uses: actions/checkout@v7'
  pins_case fail "an action at a minor version" '      - uses: actions/checkout@v7.0'
  pins_case fail "an action at a branch" '      - uses: actions/checkout@main'
  pins_case fail "a docker image at latest" '      - uses: docker://rhysd/actionlint:latest'
  pins_case fail "a docker image at a major version" '      - uses: docker://rhysd/actionlint:1'
  pins_case fail "a node-version literal" '      - uses: actions/setup-node@v7.1.0
        with:
          node-version: 24'
  pins_case fail "a quoted node-version literal" '      - uses: actions/setup-node@v7.1.0
        with:
          node-version: "24"'
  pins_case fail "buildx without a BuildKit image" '      - uses: docker/setup-buildx-action@v4.4.1
      - run: true'
  pins_case fail "buildx with other inputs and no BuildKit image" '      - uses: docker/setup-buildx-action@v4.4.1
        with:
          platforms: linux/amd64'
  pins_case fail "buildx with a moving BuildKit image" '      - uses: docker/setup-buildx-action@v4.4.1
        with:
          driver-opts: image=moby/buildkit:buildx-stable-1'
  pins_case fail "npx -y at latest" '      - run: npx -y npm@latest --version'
  pins_case fail "npx --yes without a version" '      - run: npx --yes ncu'
  pins_case fail "npx -p at a major version" '      - run: npx -p foo@1 bar'
  pins_case fail "npx --package at latest" '      - run: npx --package=foo@latest bar'
  pins_case fail "npx of a command that is not locked" '      - run: npx playwright install --with-deps chromium'
  pins_case fail "npm install at a major version" '      - run: npm install --no-save --no-audit --no-fund playwright@1'
  pins_case fail "npm i of a name without a version" '      - run: npm i -g typescript'
  pins_case fail "npm install of a version in a variable nothing proves" '      - run: |
          V=$(cat version)
          npm install "left-pad@$V"'
  pins_case fail "docker pull at latest" '      - run: docker pull alpine:latest'
  pins_case fail "docker run of a major version" '      - run: docker run --rm -v "$PWD:/work" alpine:3 true'
  pins_case pass "an action at an exact version and at a commit" '      - uses: actions/checkout@v7.0.1
      - uses: actions/cache/restore@0123456789abcdef0123456789abcdef01234567'
  pins_case pass "a local action and a docker image at an exact version and at a digest" '      - uses: ./.github/actions/local
      - uses: docker://rhysd/actionlint:1.7.12
      - uses: docker://rhysd/actionlint@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  pins_case pass "node-version-file" '      - uses: actions/setup-node@v7.1.0
        with:
          node-version-file: .node-version'
  pins_case pass "buildx with a BuildKit image, and with the docker driver" '      - uses: docker/setup-buildx-action@v4.4.1
        with:
          driver-opts: image=moby/buildkit:v0.34.1
      - uses: docker/setup-buildx-action@v4.4.1
        with:
          driver: docker'
  pins_case pass "a locked npx, npm ci, an install of the lock file and a tag written" '      - run: npx --no-install changeset status --since=origin/main
      - run: |
          npm ci --ignore-scripts
          npm install --package-lock-only --ignore-scripts --no-audit --no-fund
          docker buildx imagetools create --tag "$IMAGE:latest" "$IMAGE:$newest"'
  pins_case pass "npx -p at an exact version, and its command" '      - run: npx -p foo@1.2.3 bar
      - run: npx --package=foo@1.2.3 bar'
  pins_case pass "exact installs" '      - run: npm install --no-save playwright@1.65.0
      - run: npx -y npm@11.19.1 --version
      - run: docker run --rm -v "$PWD:/work" alpine:3.22.1 true'
  pins_case pass "a version in a variable that the same script proves" '      - run: |
          if ! [[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then exit 1; fi
          npm install "@torrent-tv/proxy@$target" --save-exact'
  pins_case pass "a comment that names a bad install" '      # npm install left-pad@latest
      - run: true'
  mkdir "$scratch/pins-all"
  {
    printf 'name: Case\non: push\njobs:\n  case:\n    runs-on: ubuntu-26.04\n    steps:\n'
    printf '      - uses: actions/checkout@v7\n      - uses: actions/setup-node@v7.1.0\n        with:\n          node-version: 24\n'
    printf '      - uses: docker/setup-buildx-action@v4.4.1\n      - uses: docker://rhysd/actionlint:latest\n'
    printf '      - run: npx -y npm@latest --version\n      - run: npm install --no-save playwright@1\n'
  } > "$scratch/pins-all/case.yml"
  workflow_pins "$scratch/pins-all" > "$scratch/out" 2>&1 || true
  expect pass "workflow-pins prints one error line for each of six bad forms in one file" \
    test "$(grep -c '^::error' "$scratch/out")" = 6
  mkdir "$scratch/pins-escape"
  printf 'name: Case\non: push\njobs:\n  case:\n    runs-on: ubuntu-26.04\n    steps:\n      - uses: owner/repo@100%%\n' > "$scratch/pins-escape/case.yml"
  workflow_pins "$scratch/pins-escape" > "$scratch/escape.out" 2>&1 || true
  expect pass "workflow-pins writes a % of the file as %25 in its error line" grep -q '@100%25' "$scratch/escape.out"

  # workflow-tokens on copies of this repository's own workflow files, changed one way each.
  mkdir "$scratch/tokens"
  cp .github/workflows/*.yml "$scratch/tokens/"
  tokens_case() {
    # tokens_case pass|fail <what> <file> <yq expression>: a copy of the workflow files with one change.
    local want=$1 what=$2 file=$3 expression=$4
    case_number=$((case_number + 1))
    mkdir "$scratch/tokens-$case_number"
    cp "$scratch"/tokens/*.yml "$scratch/tokens-$case_number/"
    if [ -n "$expression" ]; then yq -i "$expression" "$scratch/tokens-$case_number/$file"; fi
    expect "$want" "workflow-tokens: $what" workflow_tokens "$scratch/tokens-$case_number"
  }
  tokens_case pass "this repository's files" main.yml ''
  tokens_case fail "GH_TOKEN back in the env of the job that runs package code" dependencies.yml \
    '.jobs.update.env.GH_TOKEN = "${{ github.token }}"'
  tokens_case fail "GH_TOKEN on the step that tests every commit" dependencies.yml \
    '(.jobs.update.steps[] | select(.name == "Test every commit, oldest first") | .env.GH_TOKEN) = "${{ github.token }}"'
  tokens_case fail "an App token on a step of the job that runs package code" dependencies.yml \
    '(.jobs.update.steps[] | select(.name == "Test every commit, oldest first") | .env.GH_TOKEN) = "${{ steps.token.outputs.token }}"'
  tokens_case fail "a checkout of the job that runs package code keeps its token" dependencies.yml \
    '(.jobs.update.steps[] | select((.uses // "") | test("^actions/checkout@")) | .with.persist-credentials) = true'
  tokens_case fail "the release App token without the workflows permission, in publish" main.yml \
    "del(.jobs.publish.steps[] | select(.id == \"token\") | .with.permission-workflows)"
  tokens_case fail "the release App token without the workflows permission, in version" main.yml \
    "del(.jobs.version.steps[] | select(.id == \"token\") | .with.permission-workflows)"
  tokens_case fail "an App token with a permission the job does not need" main.yml \
    '(.jobs.version.steps[] | select(.id == "token") | .with.permission-packages) = "write"'
  tokens_case fail "the checkout of publish without the App token" main.yml \
    'del(.jobs.publish.steps[] | select((.uses // "") | test("^actions/checkout@")) | .with.token)'
  tokens_case fail "a step of publish that pushes with the plain GITHUB_TOKEN" main.yml \
    '(.jobs.publish.steps[] | select(.env.GH_TOKEN != null) | .env.GH_TOKEN) = "${{ github.token }}"'
  tokens_case fail "a job that pushes and is not in the table" main.yml \
    '.jobs.sneak = {"runs-on": "ubuntu-26.04", "steps": [{"run": "git push origin HEAD:refs/heads/x"}]}'
  tokens_case fail "a job of the table that is gone" main.yml 'del(.jobs.rebase-prs)'
  tokens_case fail "the plain GITHUB_TOKEN in the env of the whole workflow" main.yml '.env.GH_TOKEN = "${{ github.token }}"'
  tokens_case fail "the plain GITHUB_TOKEN in the env of a job that pushes" main.yml '.jobs.version.env.GH_TOKEN = "${{ github.token }}"'
  tokens_case fail "a step of a job that pushes writes GITHUB_TOKEN in its script" main.yml \
    '.jobs.version.steps += [{"name": "Call", "run": "curl -H \"Authorization: $GITHUB_TOKEN\" https://example.com"}]'
  tokens_case fail "a step of a job that pushes runs gh without an App token" main.yml \
    '.jobs.version.steps += [{"name": "List", "run": "gh pr list"}]'
  tokens_case fail "the plain GITHUB_TOKEN in the env of a step of a job that pushes, a step that does not run gh" main.yml \
    '.jobs.version.steps += [{"name": "Env", "run": "true", "env": {"VALUE": "${{ github.token }}"}}]'
  tokens_case fail "a secret in the env of the whole dependency workflow" dependencies.yml \
    '.env.KEY = "${{ secrets.RELEASE_APP_PRIVATE_KEY }}"'
  tokens_case fail "a dependency workflow without a job update" dependencies.yml '.jobs.refresh = .jobs.update | del(.jobs.update)'
  case_number=$((case_number + 1))
  mkdir "$scratch/tokens-$case_number"
  cp "$scratch/tokens/main.yml" "$scratch/tokens-$case_number/"
  WORKFLOW_PUSHES=$(printf '%s\n' "$WORKFLOW_PUSHES" | grep -v '^dependencies.yml|') \
    expect fail "workflow-tokens: no dependencies.yml" workflow_tokens "$scratch/tokens-$case_number"
  tokens_case fail "a step listed as holding a token that holds none" dependencies.yml \
    'del(.jobs.update.steps[] | select(.name == "Raise the packages that Dependabot alerts name") | .env)'
  tokens_case fail "a row whose job has no App token step with its id" main.yml \
    '(.jobs.publish.steps[] | select(.id == "token") | .id) = "other"'
  local row
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    WORKFLOW_PUSHES=$(printf '%s\n' "$WORKFLOW_PUSHES" | grep -vxF -- "$row") expect fail "workflow-tokens: the row of ${row%%|*} ${row#*|} deleted from the table" \
      workflow_tokens "$scratch/tokens"
  done <<< "$WORKFLOW_PUSHES"

  extra_case() {
    # extra_case pass|fail <what> <the commands of a job named extra> [<its row of the table>]: the workflow
    # files of this repository, one more file (extension $ext) with that job, and a root directory with
    # scripts for it to call.
    local want=$1 what=$2 run=$3 row=${4:-} where ext=${ext:-yml}
    case_number=$((case_number + 1))
    where=$scratch/extra-$case_number
    mkdir -p "$where/files" "$where/root/scripts"
    cp "$scratch"/tokens/*.yml "$where/files/"
    {
      printf 'name: Extra\non: push\njobs:\n  extra:\n    runs-on: ubuntu-26.04\n    permissions:\n      contents: write\n    steps:\n      - run: |\n'
      printf '%s\n' "$run" | sed 's/^/          /'
    } > "$where/files/extra.$ext"
    printf 'git("push", "origin", "x");\n' > "$where/root/scripts/sneaky.mjs"
    printf 'import { execSync } from "node:child_process";\nexecSync("git push origin HEAD");\n' > "$where/root/scripts/sneaky-exec.mjs"
    printf 'const { execSync } = require("node:child_process");\nexecSync(`git push origin HEAD`);\n' > "$where/root/scripts/sneaky-tick.cjs"
    printf '#!/bin/sh\ngit push origin HEAD\n' > "$where/root/scripts/sneaky.sh"
    printf '// git push is only a comment here\nconsole.log("hello");\n' > "$where/root/scripts/quiet.mjs"
    WORKFLOW_PUSHES=$WORKFLOW_PUSHES${row:+$'\n'$row} expect "$want" "workflow-tokens: $what" workflow_tokens "$where/files" "$where/root"
  }
  extra_case fail "an unlisted job that runs git -C <dir> push" 'git -C repo push origin HEAD:refs/heads/main'
  extra_case fail "an unlisted job that writes a ref with gh api -X PATCH" 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=0'
  extra_case fail "an unlisted job that writes a ref with gh api and fields" 'gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=0'
  extra_case fail "an unlisted job whose gh api method is on the next line" $'gh api repos/o/r/git/refs \\\n  -X POST'
  extra_case fail "an unlisted job that calls a node script that pushes" 'node scripts/sneaky.mjs'
  extra_case fail "an unlisted job that calls a shell script that pushes" 'bash scripts/sneaky.sh'
  extra_case fail "an unlisted job that calls a script with git push in a quoted string" 'node scripts/sneaky-exec.mjs'
  extra_case fail "an unlisted job that calls a script with git push in a template string" 'node scripts/sneaky-tick.cjs'
  extra_case fail "an unlisted job that calls a script of the workspace that pushes" 'node "$GITHUB_WORKSPACE/scripts/sneaky.mjs"'
  ext=yaml extra_case fail "an unlisted job in a .yaml file that pushes" 'git push origin HEAD:refs/heads/main'
  extra_case pass "an unlisted job that reads a ref with gh api and runs a script that does not push" $'gh api repos/o/r/git/refs/heads/main\nnode scripts/quiet.mjs'
  extra_case pass "a job that pushes through a script and has its row, with the GITHUB_TOKEN permissions it lists" 'node scripts/sneaky.mjs' 'extra.yml|extra|github|contents:write'
  extra_case fail "a row of the GITHUB_TOKEN with other permissions than the job has" 'node scripts/sneaky.mjs' 'extra.yml|extra|github|contents:read'
  extra_case fail "a row of the GITHUB_TOKEN with one permission more than the job has" 'node scripts/sneaky.mjs' 'extra.yml|extra|github|contents:write packages:write'

  # commit-msg-bot on the real file, and on the loop without the hook.
  expect pass "commit-msg-bot on this repository's loop" commit_msg_bot .github/workflows/dependencies.yml
  sed 's#sh [^ ]*\.githooks/commit-msg"\{0,1\}#true#' .github/workflows/dependencies.yml > "$scratch/no-hook.yml"
  expect pass "the copy without the hook differs from the file" test -n "$(diff .github/workflows/dependencies.yml "$scratch/no-hook.yml" || true)"
  expect fail "commit-msg-bot on a loop that does not run the hook" commit_msg_bot "$scratch/no-hook.yml"

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
  workflow-pins) workflow_pins "${2:-.github/workflows}" ;;
  workflow-tokens) workflow_tokens "${2:-.github/workflows}" ;;
  commit-msg-bot) commit_msg_bot "${2:-.github/workflows/dependencies.yml}" ;;
  workflow-selftest) workflow_selftest ;;
  all) tools && pins && workflow_pins && workflow_tokens && commit_msg_bot && install && guard && tests && image ;;
  *) echo "usage: bash scripts/check.sh tools|pins|install|guard|test|image|copies [<base> [<head>]]|changeset-format [<base> [<head>]]|changesets-selftest|workflow-pins|workflow-tokens|commit-msg-bot|workflow-selftest|all" >&2; exit 2 ;;
esac
