/**
 * @file `scripts/install-native.sh <package dir>` builds and checks the
 * proxy's native modules for every image that installs the proxy
 * (torrent-tv/meta#302, design Decision 1: AC-2).
 *
 * Each check builds a package directory in its own temp directory and runs the
 * script with `sh`, from a different working directory, with a directory of
 * fakes first on `PATH`:
 *
 * - `npm` logs its working directory, its arguments and
 *   `npm_config_build_from_source`, and writes what a real rebuild or install
 *   would leave behind. `rebuild utp-native` fails
 *   with FAKE_UTP_BUILD_FAIL=1, else writes `utp_native.node` with
 *   `obj.target` and `.deps`; `install … utp-native@npm:@torrent-tv/utp-native@…`
 *   puts ours at the top.
 * - `node` answers `-p process.versions.node` (and `--version`) with
 *   FAKE_NODE_VERSION and hands every other call to the real node.
 * - `node_modules/node-datachannel` is a fake package: it loads and reports
 *   its libdatachannel version, throws a two-line error when it is required,
 *   or is absent.
 *
 * The real `npm` never runs, nothing touches the network and no torrent is
 * involved.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const PROXY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(PROXY, "scripts/install-native.sh");
const SPEC = "npm:@torrent-tv/utp-native@2.5.3-ttv.9";
const NDC_VERSION = "0.33.6";
const NDC_LIBRARY_VERSION = "0.24.6";
const NDC_ERROR_FIRST_LINE = "fake binding: libstdc++.so.6: cannot open shared object file";
const NDC_ERROR_SECOND_LINE = "fake binding: second line of the loader message";
const NDC_LOADS = `module.exports = { getLibraryVersion: () => "${NDC_LIBRARY_VERSION}" };\n`;
const NDC_THROWS = `throw new Error("${NDC_ERROR_FIRST_LINE}\\n${NDC_ERROR_SECOND_LINE}");\n`;

const root = mkdtempSync(path.join(tmpdir(), "ttv-install-native-"));
after(() => rmSync(root, { recursive: true, force: true }));

const FAKE_NPM = `#!/bin/sh
printf '%s|%s|%s\\n' "$PWD" "$*" "\${npm_config_build_from_source:-}" >> "$FAKE_LOG"
case " $* " in
  *" rebuild "*utp-native*)
    if [ "\${FAKE_UTP_BUILD_FAIL:-}" = "1" ]; then
      echo "fake npm: gyp failed" >&2
      exit 1
    fi
    mkdir -p node_modules/utp-native/build/Release/obj.target/utp_native node_modules/utp-native/build/Release/.deps
    : > node_modules/utp-native/build/Release/utp_native.node
    : > node_modules/utp-native/build/Release/obj.target/utp_native.node
    : > node_modules/utp-native/build/Release/.deps/utp_native.d
    exit 0
    ;;
  *" install "*"utp-native@npm:@torrent-tv/utp-native@"*)
    rm -rf node_modules/utp-native
    mkdir -p node_modules/utp-native
    printf '{"name":"@torrent-tv/utp-native","version":"2.5.3-ttv.9"}\\n' > node_modules/utp-native/package.json
    exit 0
    ;;
esac
echo "fake npm: unexpected call: $*" >&2
exit 3
`;

const FAKE_NODE = `#!/bin/sh
if [ "$#" -eq 2 ] && { [ "$1" = "-p" ] || [ "$1" = "--print" ]; } && [ "$2" = "process.versions.node" ]; then
  echo "$FAKE_NODE_VERSION"
  exit 0
fi
if [ "$#" -eq 1 ] && { [ "$1" = "--version" ] || [ "$1" = "-v" ]; }; then
  echo "v$FAKE_NODE_VERSION"
  exit 0
fi
exec "$REAL_NODE" "$@"
`;

let next = 0;

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A package directory as `npm ci --ignore-scripts` leaves it, and the fakes.
 *
 * @param {{
 *   engines?: string | null,
 *   spec?: string | null,
 *   top?: "ours" | "foreign" | "missing",
 *   packageJson?: boolean,
 *   ndc?: "loads" | "throws" | "absent",
 * }} [options]
 */
function makeCase({ engines = ">=24", spec = SPEC, top = "ours", packageJson = true, ndc = "loads" } = {}) {
  next += 1;
  const base = path.join(root, `case-${next}`);
  const pkg = path.join(base, "package");
  const fakes = path.join(base, "fakes");
  const state = path.join(base, "state");
  const elsewhere = path.join(base, "elsewhere");
  for (const dir of [pkg, fakes, state, elsewhere]) mkdirSync(dir, { recursive: true });

  if (packageJson) {
    const manifest = { name: "@torrent-tv/proxy", version: "0.0.0-development", type: "module" };
    if (engines !== null) manifest.engines = { node: engines };
    if (spec !== null) manifest.overrides = { "utp-native": spec };
    writeJson(path.join(pkg, "package.json"), manifest);
  }
  if (ndc !== "absent") {
    const dir = path.join(pkg, "node_modules/node-datachannel");
    writeJson(path.join(dir, "package.json"), { name: "node-datachannel", version: NDC_VERSION, main: "index.js" });
    writeFileSync(path.join(dir, "index.js"), ndc === "loads" ? NDC_LOADS : NDC_THROWS);
  }
  if (top === "ours") {
    writeJson(path.join(pkg, "node_modules/utp-native/package.json"), { name: "@torrent-tv/utp-native", version: "2.5.3-ttv.9" });
  } else if (top === "foreign") {
    writeJson(path.join(pkg, "node_modules/utp-native/package.json"), { name: "utp-native", version: "2.5.3" });
  }

  for (const [name, body] of [["npm", FAKE_NPM], ["node", FAKE_NODE]]) {
    writeFileSync(path.join(fakes, name), body);
    chmodSync(path.join(fakes, name), 0o755);
  }

  return { base, pkg, fakes, state, elsewhere };
}

/**
 * Runs the script for a case.
 *
 * @param {ReturnType<typeof makeCase>} c
 * @param {{ args?: string[], env?: Record<string, string | undefined> }} [options]
 */
function run(c, { args = [c.pkg], env = {} } = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key))
  );
  const merged = {
    ...inherited,
    PATH: `${c.fakes}${path.delimiter}${process.env.PATH}`,
    REAL_NODE: process.execPath,
    FAKE_LOG: path.join(c.state, "npm.log"),
    FAKE_STATE: c.state,
    FAKE_NODE_VERSION: "24.11.0",
    ...env,
  };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  const result = spawnSync("sh", [SCRIPT, ...args], { cwd: c.elsewhere, env: merged, encoding: "utf8", timeout: 60_000 });
  const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  const calls = lines(path.join(c.state, "npm.log")).map((line) => {
    const [cwd, argv, fromSource] = line.split("|");
    return { cwd, argv, fromSource };
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    calls,
  };
}

/** @param {ReturnType<typeof run>} r */
function said(r) {
  return `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}\nnpm calls:\n${r.calls.map((c) => `${c.cwd} $ npm ${c.argv}`).join("\n")}`;
}

const isNdc = (call) => /(^|\s)rebuild(\s|$)/.test(call.argv) && /node-datachannel/.test(call.argv);
const isUtpBuild = (call) => /(^|\s)rebuild(\s|$)/.test(call.argv) && /utp-native/.test(call.argv);
const isInstall = (call) => /(^|\s)install(\s|$)/.test(call.argv);

// ---------------------------------------------------------------- usage

test("without an argument the script prints its usage on stderr and exits 2 without calling npm", () => {
  const c = makeCase();
  const r = run(c, { args: [] });
  assert.equal(r.status, 2, said(r));
  assert.match(r.stderr, /usage/i, said(r));
  assert.equal(r.calls.length, 0, said(r));
});

test("a directory without package.json gets the usage on stderr and exit 2 without calling npm", () => {
  const c = makeCase({ packageJson: false });
  const r = run(c);
  assert.equal(r.status, 2, said(r));
  assert.match(r.stderr, /usage/i, said(r));
  assert.equal(r.calls.length, 0, said(r));
});

// ---------------------------------------------------------------- happy path

test("a valid package exits 0", () => {
  const r = run(makeCase());
  assert.equal(r.status, 0, said(r));
});

test("the node line names the running version and the floor from engines.node", () => {
  const r = run(makeCase());
  assert.match(r.stdout, /^install-native: node v24\.11\.0 \(floor 24\)$/m, said(r));
});

test("every npm call runs in the package directory and none is global", () => {
  const c = makeCase({ top: "missing" });
  const r = run(c);
  assert.ok(r.calls.length > 0, said(r));
  for (const call of r.calls) {
    assert.equal(path.resolve(call.cwd), path.resolve(c.pkg), said(r));
    assert.doesNotMatch(call.argv, /(^|\s)(--global|-g)(\s|$)/, said(r));
  }
});

test("npm calls follow the steps: the install of ours, then the source build", () => {
  const r = run(makeCase({ top: "missing" }));
  const order = r.calls
    .map((call) => (isInstall(call) ? "install" : isUtpBuild(call) ? "utp" : call.argv));
  assert.deepEqual(order, ["install", "utp"], said(r));
});

// ---------------------------------------------------------------- 1. node floor

test("node exactly at the floor passes the floor check", () => {
  const r = run(makeCase(), { env: { FAKE_NODE_VERSION: "24.0.0" } });
  assert.equal(r.status, 0, said(r));
  assert.match(r.stdout, /^install-native: node v24\.0\.0 \(floor 24\)$/m, said(r));
});

test("node one major below the floor is refused with exit 1 before any npm call", () => {
  const r = run(makeCase(), { env: { FAKE_NODE_VERSION: "23.11.1" } });
  assert.equal(r.status, 1, said(r));
  assert.match(r.stderr, /^FATAL: install-native: this proxy requires Node 24 or newer; found v23\.11\.1$/m, said(r));
  assert.equal(r.calls.length, 0, said(r));
});

test("an engines.node that is not >=N is refused with exit 1 and names the value", () => {
  const r = run(makeCase({ engines: "^24" }));
  assert.equal(r.status, 1, said(r));
  assert.match(r.stderr, /^FATAL: install-native: engines\.node must be ">=N", found \^24$/m, said(r));
  assert.equal(r.calls.length, 0, said(r));
});

test("an engines.node with a non-integer floor is refused with exit 1", () => {
  const r = run(makeCase({ engines: ">=24.1" }));
  assert.equal(r.status, 1, said(r));
  assert.match(r.stderr, /^FATAL: install-native: engines\.node must be ">=N", found >=24\.1$/m, said(r));
});

test("a package without engines.node is refused with exit 1", () => {
  const r = run(makeCase({ engines: null }));
  assert.equal(r.status, 1, said(r));
  assert.match(r.stderr, /^FATAL: install-native: engines\.node must be ">=N", found /m, said(r));
});

// ---------------------------------------------------------------- 2. node-datachannel

test("a node-datachannel whose binding loads is reported with its version and its libdatachannel version", () => {
  const r = run(makeCase());
  assert.equal(r.status, 0, said(r));
  assert.match(
    r.stdout,
    new RegExp(`^install-native: node-datachannel ${NDC_VERSION.replaceAll(".", "\\.")}: binding loads \\(libdatachannel ${NDC_LIBRARY_VERSION.replaceAll(".", "\\.")}\\)$`, "m"),
    said(r)
  );
});

test("a node-datachannel whose require throws ends with a FATAL carrying the first line of the error and exit 1", () => {
  const r = run(makeCase({ top: "missing", ndc: "throws" }));
  assert.notEqual(r.status, 0, said(r));
  const fatal = r.stderr.split("\n").filter((line) => line.startsWith("FATAL: install-native:"));
  assert.equal(fatal.length, 1, said(r));
  assert.ok(fatal[0].includes("node-datachannel"), said(r));
  assert.ok(fatal[0].includes(NDC_ERROR_FIRST_LINE), said(r));
  assert.ok(!fatal[0].includes(NDC_ERROR_SECOND_LINE), said(r));
  assert.doesNotMatch(r.stdout, /binding loads/, said(r));
  assert.equal(r.calls.filter((call) => isInstall(call) || isUtpBuild(call)).length, 0, said(r));
});

test("an absent node-datachannel package ends with a FATAL naming the package and exit 1", () => {
  const r = run(makeCase({ ndc: "absent" }));
  assert.notEqual(r.status, 0, said(r));
  assert.match(r.stderr, /^FATAL: install-native: .*node-datachannel/m, said(r));
  assert.doesNotMatch(r.stderr, /no native binary/, said(r));
  assert.doesNotMatch(r.stdout, /binding loads/, said(r));
});

test("the script never rebuilds node-datachannel", () => {
  const r = run(makeCase());
  assert.equal(r.calls.filter(isNdc).length, 0, said(r));
});

// ---------------------------------------------------------------- 3. utp-native spec

test("the pinned utp-native spec is printed", () => {
  const r = run(makeCase());
  assert.match(r.stdout, /^utp-native: the proxy pins npm:@torrent-tv\/utp-native@2\.5\.3-ttv\.9$/m, said(r));
});

test("a package that pins no utp-native is refused with exit 1 and the value undefined", () => {
  const r = run(makeCase({ spec: null }));
  assert.equal(r.status, 1, said(r));
  assert.match(r.stderr, /^FATAL: install-native: the proxy pins no utp-native build of ours: undefined$/m, said(r));
});

test("a package that pins a registry utp-native is refused with exit 1 and that value", () => {
  const r = run(makeCase({ spec: "^2.5.3" }));
  assert.equal(r.status, 1, said(r));
  assert.match(r.stderr, /^FATAL: install-native: the proxy pins no utp-native build of ours: \^2\.5\.3$/m, said(r));
});

// ---------------------------------------------------------------- 4. ours at the top

test("when ours is already at the top nothing is installed", () => {
  const r = run(makeCase({ top: "ours" }));
  assert.equal(r.status, 0, said(r));
  assert.equal(r.calls.filter(isInstall).length, 0, said(r));
});

const INSTALL = `install --omit=dev --ignore-scripts --no-save --no-audit --no-fund utp-native@${SPEC}`;

test("when no utp-native is at the top ours is installed without saving", () => {
  const r = run(makeCase({ top: "missing" }));
  assert.deepEqual(r.calls.filter(isInstall).map((call) => call.argv), [INSTALL], said(r));
});

test("when a foreign utp-native is at the top ours is installed without saving", () => {
  const r = run(makeCase({ top: "foreign" }));
  assert.deepEqual(r.calls.filter(isInstall).map((call) => call.argv), [INSTALL], said(r));
});

// ---------------------------------------------------------------- 5. nested copies

test("nested utp-native copies are removed and the top one stays", () => {
  const c = makeCase();
  const shallow = path.join(c.pkg, "node_modules/webtorrent/node_modules/utp-native");
  const deep = path.join(c.pkg, "node_modules/a/node_modules/b/node_modules/utp-native");
  writeJson(path.join(shallow, "package.json"), { name: "utp-native", version: "2.5.3" });
  writeJson(path.join(deep, "package.json"), { name: "utp-native", version: "2.5.3" });
  const r = run(c);
  assert.equal(r.status, 0, said(r));
  assert.equal(existsSync(shallow), false, `still there: ${shallow}\n${said(r)}`);
  assert.equal(existsSync(deep), false, `still there: ${deep}\n${said(r)}`);
  assert.equal(existsSync(path.join(c.pkg, "node_modules/utp-native/package.json")), true, said(r));
});

test("a directory whose name only starts with utp-native is not removed", () => {
  const c = makeCase();
  const lookalike = path.join(c.pkg, "node_modules/webtorrent/node_modules/utp-native-legacy");
  writeJson(path.join(lookalike, "package.json"), { name: "utp-native-legacy", version: "1.0.0" });
  const r = run(c);
  assert.equal(r.status, 0, said(r));
  assert.equal(existsSync(lookalike), true, said(r));
});

// ---------------------------------------------------------------- 6. source build

test("utp-native is rebuilt from source", () => {
  const r = run(makeCase());
  const builds = r.calls.filter(isUtpBuild);
  assert.equal(builds.length, 1, said(r));
  assert.equal(builds[0].fromSource, "true", said(r));
});

test("a failed utp-native build warns on stderr and still exits 0", () => {
  const r = run(makeCase(), { env: { FAKE_UTP_BUILD_FAIL: "1" } });
  assert.equal(r.status, 0, said(r));
  assert.match(r.stderr, /^WARNING: utp-native build failed; peer connections stay TCP-only$/m, said(r));
});

// ---------------------------------------------------------------- 7. provenance

test("our built utp_native.node gets the provenance line", () => {
  const r = run(makeCase());
  assert.match(r.stdout, /^utp-native: our build at \S*node_modules\/utp-native\/build\/Release\/utp_native\.node$/m, said(r));
});

test("with no utp_native.node at all there is no provenance line and the exit is 0", () => {
  const r = run(makeCase(), { env: { FAKE_UTP_BUILD_FAIL: "1" } });
  assert.equal(r.status, 0, said(r));
  assert.doesNotMatch(r.stdout, /our build at/, said(r));
});

test("a utp_native.node in a package that is not ours is refused with exit 1 and its path", () => {
  const c = makeCase();
  writeJson(path.join(c.pkg, "node_modules/legacy-utp/package.json"), { name: "utp-native", version: "2.5.3" });
  mkdirSync(path.join(c.pkg, "node_modules/legacy-utp/build/Release"), { recursive: true });
  writeFileSync(path.join(c.pkg, "node_modules/legacy-utp/build/Release/utp_native.node"), "");
  const r = run(c);
  assert.equal(r.status, 1, said(r));
  assert.match(r.stderr, /^FATAL: install-native: \S*node_modules\/legacy-utp\/build\/Release\/utp_native\.node is not our build$/m, said(r));
});

test("a utp_native.node under obj.target is not checked for provenance", () => {
  const r = run(makeCase());
  assert.equal(r.status, 0, said(r));
  assert.doesNotMatch(r.stdout + r.stderr, /obj\.target\/utp_native\.node/, said(r));
});

// ---------------------------------------------------------------- 8. clean-up

test("obj.target and .deps under every build/Release are removed and the binaries stay", () => {
  const c = makeCase();
  const r = run(c);
  assert.equal(r.status, 0, said(r));
  const release = path.join(c.pkg, "node_modules/utp-native/build/Release");
  assert.equal(existsSync(path.join(release, "obj.target")), false, `obj.target\n${said(r)}`);
  assert.equal(existsSync(path.join(release, ".deps")), false, `.deps\n${said(r)}`);
  assert.equal(existsSync(path.join(release, "utp_native.node")), true, said(r));
});

test("an obj.target directory not directly under build/Release is kept", () => {
  const c = makeCase();
  const elsewhere = path.join(c.pkg, "node_modules/some-tool/obj.target");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(elsewhere, "keep.txt"), "");
  const r = run(c);
  assert.equal(r.status, 0, said(r));
  assert.equal(existsSync(elsewhere), true, said(r));
});
