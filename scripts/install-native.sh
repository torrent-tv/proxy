#!/bin/sh
# Builds and checks the proxy's two native modules in an installed proxy:
# node-datachannel (WebRTC) and utp-native (our fork, uTP to peers). Every
# image that installs the proxy runs this one script after its install with
# `--ignore-scripts` (torrent-tv/meta#302).
#
#   sh scripts/install-native.sh <package dir>
#
# <package dir> holds the installed proxy: its package.json and node_modules/.
# INSTALL_NATIVE_RETRY_DELAY is the wait in seconds between node-datachannel
# attempts (default 10). npm and node are taken from PATH, and every npm call
# runs in the package directory, never with --global.

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

# 2. node-datachannel fetches a prebuilt binary; one failed request ends the
# rebuild, so it is tried up to five times. Without the binary the proxy has no
# WebRTC.
delay=${INSTALL_NATIVE_RETRY_DELAY:-10}
attempt=1
while ! npm rebuild node-datachannel; do
  if [ "$attempt" -ge 5 ]; then
    break
  fi
  echo "install-native: node-datachannel attempt $attempt of 5 failed; retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
binary_found=
for binary in node_modules/node-datachannel/build/Release/*.node; do
  if [ -f "$binary" ]; then
    binary_found=1
  fi
done
[ -n "$binary_found" ] || fatal "node-datachannel has no native binary; the proxy would have no WebRTC"

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
