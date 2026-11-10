#!/usr/bin/env bash
# The checks that need no secret: main.yml runs them one step each, so a run shows
# which one failed; dependencies.yml runs `all` on every commit it prepares.
#
#   bash scripts/check.sh tools | pins | install | guard | test | image
#   bash scripts/check.sh all
#
# None of them starts a real torrent: `guard` refuses a check that could, and `test`
# loads test/no-torrent/support/refuse-torrent.cjs (AGENTS.md, "Checks").
set -euo pipefail
cd "$(dirname "$0")/.."

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

case "${1:-}" in
  tools) tools ;;
  pins) pins ;;
  install) install ;;
  guard) guard ;;
  test) tests ;;
  image) image ;;
  all) tools && pins && install && guard && tests && image ;;
  *) echo "usage: bash scripts/check.sh tools|pins|install|guard|test|image|all" >&2; exit 2 ;;
esac
