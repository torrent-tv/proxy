#!/bin/sh
# Checks that node-datachannel (WebRTC) loads and builds utp-native (our fork,
# uTP to peers) in an installed proxy. Every image that installs the proxy runs
# this one script after its install with `--ignore-scripts`
# (torrent-tv/meta#302).
#
#   sh scripts/install-native.sh <package dir>
#
# <package dir> holds the installed proxy: its package.json and node_modules/.
# npm and node are taken from PATH, and every npm call runs in the package
# directory, never with --global.

set -eu

usage() {
  echo "usage: install-native.sh <package dir>" >&2
  echo "  <package dir> holds the installed proxy (package.json and node_modules/)" >&2
  exit 2
}

fatal() {
  echo "FATAL: install-native: $*" >&2
  exit 1
}

# Prints a field of a JSON file, or `undefined` when it is absent.
# json_field <file> <key> [<key>...]
json_field() {
  node -e '
const [file, ...keys] = process.argv.slice(1);
let value = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
for (const key of keys) value = value === null || typeof value !== "object" ? undefined : value[key];
process.stdout.write(String(value));
' "$@"
}

[ "$#" -eq 1 ] || usage
[ -f "$1/package.json" ] || usage
cd "$1"
package_dir=$(pwd)

# 1. Node floor, as the package states it in engines.node.
engines=$(json_field package.json engines node)
case $engines in
  ">="*) floor=${engines#>=} ;;
  *) floor= ;;
esac
case $floor in
  "" | *[!0-9]*) fatal "engines.node must be \">=N\", found $engines" ;;
esac
version=$(node -p process.versions.node)
major=${version%%.*}
case $major in
  "" | *[!0-9]*) fatal "cannot read the running Node version: $version" ;;
esac
if [ "$major" -lt "$floor" ]; then
  fatal "this proxy requires Node $floor or newer; found v$version"
fi
echo "install-native: node v$version (floor $floor)"

# 2. node-datachannel ships its binary as an optional per-platform npm package
# that `npm ci` installs by itself, so there is nothing to build or fetch here.
# The one fact this step needs is that this node loads the binding the install
# left, and only the package's own loader answers it. Without the binding the
# proxy has no WebRTC.
if ndc=$(node -e '
const fs = require("node:fs");
try {
  const ndc = require("node-datachannel");
  const version = JSON.parse(fs.readFileSync("node_modules/node-datachannel/package.json", "utf8")).version;
  process.stdout.write(version + " " + ndc.getLibraryVersion());
} catch (error) {
  process.stdout.write(String((error && error.message) || error).split("\n")[0]);
  process.exit(1);
}
'); then
  echo "install-native: node-datachannel ${ndc% *}: binding loads (libdatachannel ${ndc#* })"
else
  fatal "node-datachannel binding does not load: ${ndc:-no error message}"
fi

# 3. The proxy pins our utp-native fork through overrides.
spec=$(json_field package.json overrides utp-native)
case $spec in
  "npm:@torrent-tv/utp-native@"*) ;;
  *) fatal "the proxy pins no utp-native build of ours: $spec" ;;
esac
echo "utp-native: the proxy pins $spec"

# 4. Ours at the top. A global install ignores overrides, so the top copy may
# be missing or foreign; after `npm ci` it is already ours.
top=
if [ -f node_modules/utp-native/package.json ]; then
  top=$(json_field node_modules/utp-native/package.json name)
fi
if [ "$top" != "@torrent-tv/utp-native" ]; then
  npm install --omit=dev --ignore-scripts --no-save --no-audit --no-fund "utp-native@$spec"
fi

# 5. Nested copies are removed, so every require of utp-native reaches ours.
find node_modules -mindepth 3 -type d -name utp-native -prune -exec rm -rf {} +

# 6. Source build, best effort: without it peers are reached over TCP only.
if ! npm_config_build_from_source=true npm rebuild utp-native; then
  echo "WARNING: utp-native build failed; peer connections stay TCP-only" >&2
fi

# 7. Provenance: every utp_native.node belongs to our package.
find node_modules -type d -name obj.target -prune -o \
  -type f -path "*/build/Release/utp_native.node" -print |
  while IFS= read -r binary; do
    owner=$(dirname "$(dirname "$(dirname "$binary")")")
    name=undefined
    if [ -f "$owner/package.json" ]; then
      name=$(json_field "$owner/package.json" name)
    fi
    if [ "$name" != "@torrent-tv/utp-native" ]; then
      fatal "$package_dir/$binary is not our build"
    fi
    echo "utp-native: our build at $package_dir/$binary"
  done

# 8. Clean-up: the intermediate build files are not shipped.
find node_modules -type d \( -path "*/build/Release/obj.target" -o -path "*/build/Release/.deps" \) \
  -prune -exec rm -rf {} +

exit 0
