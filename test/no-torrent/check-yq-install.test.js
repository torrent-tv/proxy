/**
 * @file `bash scripts/check.sh yq-install` installs the pinned yq on the runner, whatever yq the
 * runner image ships (torrent-tv/meta#472, openspec change `pin-yq-by-install`: AC-1, AC-2, AC-6).
 *
 * Each check copies `scripts/check.sh` into a scratch repository, sets the committed digest to
 * the digest of a fake binary where the case needs a matching one, and runs the subcommand with
 * `YQ_DOWNLOAD_BASE=file://<scratch>/releases` and `YQ_BIN_DIR=<scratch>/bin`. The fake `yq_linux_amd64`
 * is a shell script that prints the version line of the real yq. Nothing touches the network, the
 * real `yq` is never needed and no torrent is involved.
 *
 * The workflow checks read workflow files as text (no YAML library, as `check.sh` does for most).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const PROXY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VERSION = "4.54.1";
const COMMITTED_SHA256 = "8e34fc298390875de416e6a4afcb8cabeceb25d9aa8506c1a2f9353cf702ea5f";
const VERSION_LINE = `yq (https://github.com/mikefarah/yq/) version v${VERSION}`;
const MISMATCH_ERROR = `::error::yq_linux_amd64 v${VERSION} does not match the pinned SHA-256`;
const FAKE_YQ = `#!/bin/sh\necho "${VERSION_LINE}"\n`;

const root = mkdtempSync(path.join(tmpdir(), "ttv-yq-install-"));
after(() => rmSync(root, { recursive: true, force: true }));

const sourceOf = (file) => readFileSync(path.join(PROXY, file), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

let caseNumber = 0;

/**
 * A scratch repository: `scripts/check.sh` (its digest line set to `digest` when given),
 * `releases/v<version>/yq_linux_amd64` holding `binary` (nothing when `binary` is null).
 */
function scratchRepository({ digest, binary = FAKE_YQ, releaseVersion = VERSION } = {}) {
  caseNumber += 1;
  const dir = path.join(root, `case-${caseNumber}`);
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  let script = sourceOf("scripts/check.sh");
  if (digest !== undefined) script = script.replace(/^YQ_SHA256=.*$/m, `YQ_SHA256=${digest}`);
  writeFileSync(path.join(dir, "scripts/check.sh"), script);
  if (binary !== null) {
    mkdirSync(path.join(dir, "releases", `v${releaseVersion}`), { recursive: true });
    writeFileSync(path.join(dir, "releases", `v${releaseVersion}`, "yq_linux_amd64"), binary);
  }
  return dir;
}

function runYqInstall(dir, { extraEnv = {}, pathValue = process.env.PATH } = {}) {
  const env = {
    PATH: pathValue,
    HOME: dir,
    YQ_DOWNLOAD_BASE: `file://${dir}/releases`,
    YQ_BIN_DIR: path.join(dir, "bin"),
    ...extraEnv,
  };
  const result = spawnSync("/bin/bash", [path.join(dir, "scripts/check.sh"), "yq-install"], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, bin: path.join(dir, "bin") };
}

const binFiles = (bin) => (existsSync(bin) ? readdirSync(bin) : []);

/** A PATH directory that has the tools check.sh needs except those named in `without`. */
function pathWithout(dir, without) {
  const tools = path.join(dir, "path-tools");
  mkdirSync(tools, { recursive: true });
  for (const name of ["bash", "dirname", "mkdir", "chmod", "mv", "rm", "cat", "env", "sed", "grep", "tr", "head", "tail", "sort", "uniq", "mktemp", "curl", "sha256sum", "shasum"]) {
    if (without.includes(name)) continue;
    for (const place of ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/sbin"]) {
      const candidate = path.join(place, name);
      if (existsSync(candidate)) {
        symlinkSync(candidate, path.join(tools, name));
        break;
      }
    }
  }
  return tools;
}

test("the pinned version is 4.54.1 and its SHA-256 is committed in check.sh", { todo: "AC-1" }, () => {
  const script = sourceOf("scripts/check.sh");
  assert.match(script, /^YQ_VERSION=4\.54\.1$/m, "YQ_VERSION is 4.54.1");
  assert.match(script, new RegExp(`^YQ_SHA256=${COMMITTED_SHA256}$`, "m"), "YQ_SHA256 is the digest of yq_linux_amd64 v4.54.1");
});

test("yq-install installs the downloaded binary when its digest matches the pinned one", { todo: "AC-1" }, () => {
  const dir = scratchRepository({ digest: sha256(FAKE_YQ) });
  const { status, output, bin } = runYqInstall(dir);
  assert.equal(status, 0, output);
  accessSync(path.join(bin, "yq"), constants.X_OK);
  assert.deepEqual(binFiles(bin), ["yq"], "no partial download is left beside yq");
  assert.ok(output.includes(VERSION_LINE), `the version line of the installed yq is printed: ${output}`);
});

test("yq-install appends the bin directory to GITHUB_PATH when it is set", { todo: "AC-1" }, () => {
  const dir = scratchRepository({ digest: sha256(FAKE_YQ) });
  const githubPath = path.join(dir, "github-path");
  writeFileSync(githubPath, "/already/there\n");
  const { status, output, bin } = runYqInstall(dir, { extraEnv: { GITHUB_PATH: githubPath } });
  assert.equal(status, 0, output);
  assert.equal(readFileSync(githubPath, "utf8"), `/already/there\n${bin}\n`);
});

test("yq-install installs yq under RUNNER_TEMP when YQ_BIN_DIR is not set", { todo: "AC-1" }, () => {
  const dir = scratchRepository({ digest: sha256(FAKE_YQ) });
  const runnerTemp = path.join(dir, "runner-temp");
  mkdirSync(runnerTemp);
  const env = { PATH: process.env.PATH, HOME: dir, YQ_DOWNLOAD_BASE: `file://${dir}/releases`, RUNNER_TEMP: runnerTemp };
  const result = spawnSync("/bin/bash", [path.join(dir, "scripts/check.sh"), "yq-install"], { cwd: dir, env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  accessSync(path.join(runnerTemp, "yq-bin", "yq"), constants.X_OK);
});

test("yq-install refuses a binary with another digest, names the error and leaves no yq", { todo: "AC-2" }, () => {
  const dir = scratchRepository({ digest: sha256(FAKE_YQ), binary: `${FAKE_YQ}# tampered\n` });
  const githubPath = path.join(dir, "github-path");
  const { status, output, bin } = runYqInstall(dir, { extraEnv: { GITHUB_PATH: githubPath } });
  assert.notEqual(status, 0, "the install fails");
  assert.ok(output.includes(MISMATCH_ERROR), `the output has the ::error:: line: ${output}`);
  assert.deepEqual(binFiles(bin), [], "neither yq nor yq.part stays in the bin directory");
  assert.equal(existsSync(githubPath), false, "the bin directory is not added to GITHUB_PATH");
});

test("yq-install refuses an empty download as a digest mismatch", { todo: "AC-2" }, () => {
  const dir = scratchRepository({ digest: sha256(FAKE_YQ), binary: "" });
  const { status, output, bin } = runYqInstall(dir);
  assert.notEqual(status, 0);
  assert.ok(output.includes(MISMATCH_ERROR), output);
  assert.deepEqual(binFiles(bin), []);
});

test("yq-install fails when the release has no yq_linux_amd64, installs nothing and does not call it a mismatch", { todo: "AC-2" }, () => {
  const dir = scratchRepository({ digest: sha256(FAKE_YQ), binary: null });
  const { status, output, bin } = runYqInstall(dir);
  assert.notEqual(status, 0, "a download failure fails the install");
  assert.doesNotMatch(output, /usage:/, "the subcommand exists");
  assert.match(output, /curl: \(\d+\)/, `curl's own error is shown: ${output}`);
  assert.equal(output.includes(MISMATCH_ERROR), false, "a failed download is not reported as a digest mismatch");
  assert.deepEqual(binFiles(bin), []);
});

test("yq-install downloads the pinned version only: a release of another version is not used", { todo: "AC-2" }, () => {
  const dir = scratchRepository({ digest: sha256(FAKE_YQ), releaseVersion: "4.54.3" });
  const { status, output, bin } = runYqInstall(dir);
  assert.notEqual(status, 0);
  assert.doesNotMatch(output, /usage:/);
  assert.match(output, /curl: \(\d+\)/, output);
  assert.deepEqual(binFiles(bin), [], "the 4.54.3 binary was not installed");
});

test("yq-install fails and installs nothing when curl is missing", { todo: "AC-2" }, () => {
  const dir = scratchRepository({ digest: sha256(FAKE_YQ) });
  const { status, output, bin } = runYqInstall(dir, { pathValue: pathWithout(dir, ["curl"]) });
  assert.notEqual(status, 0);
  assert.doesNotMatch(output, /usage:/);
  assert.match(output, /curl/, output);
  assert.deepEqual(binFiles(bin), []);
});

test("yq-install fails and installs nothing when sha256sum is missing", { todo: "AC-2" }, () => {
  const dir = scratchRepository({ digest: sha256(FAKE_YQ) });
  const { status, output, bin } = runYqInstall(dir, { pathValue: pathWithout(dir, ["sha256sum", "shasum"]) });
  assert.notEqual(status, 0);
  assert.doesNotMatch(output, /usage:/);
  assert.match(output, /sha256sum/, output);
  assert.deepEqual(binFiles(bin), []);
});

test("yq-install overwrites an older yq in the bin directory only with a verified one", { todo: "AC-2" }, () => {
  const dir = scratchRepository({ digest: sha256(FAKE_YQ), binary: "not yq\n" });
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "yq"), "#!/bin/sh\necho old\n");
  chmodSync(path.join(bin, "yq"), 0o755);
  const { status, output } = runYqInstall(dir);
  assert.notEqual(status, 0);
  assert.ok(output.includes(MISMATCH_ERROR), output);
  assert.equal(readFileSync(path.join(bin, "yq"), "utf8"), "#!/bin/sh\necho old\n", "a refused download leaves the earlier yq untouched");
  assert.equal(existsSync(path.join(bin, "yq.part")), false);
});

/** The text of the step named `name` in a workflow file, up to the next step or job. */
function stepIndex(text, name) {
  return text.indexOf(`- name: ${name}`);
}

function stepText(text, name) {
  const start = stepIndex(text, name);
  assert.notEqual(start, -1, `step "${name}" exists`);
  const rest = text.slice(start + 1);
  const next = rest.search(/^\s*- (name|uses):|^ {2}[a-z-]+:$/m);
  return text.slice(start, next === -1 ? undefined : start + 1 + next);
}

test("main.yml job checks installs yq before the first step that reads the workflows", { todo: "AC-1" }, () => {
  const main = sourceOf(".github/workflows/main.yml");
  const jobStart = main.indexOf("\n  checks:\n");
  const jobEnd = main.indexOf("\n  build:\n");
  const install = stepIndex(main, "yq is the pinned version");
  const firstUse = stepIndex(main, "Workflow tools are pinned exactly");
  assert.ok(install > jobStart && install < jobEnd, "the step is in job checks");
  assert.ok(install < firstUse, "the step comes before `Workflow tools are pinned exactly`");
  assert.match(stepText(main, "yq is the pinned version"), /run: bash scripts\/check\.sh yq-install\s*$/);
});

test("dependencies.yml job update installs yq before the step that runs check.sh all", { todo: "AC-1" }, () => {
  const dependencies = sourceOf(".github/workflows/dependencies.yml");
  const jobStart = dependencies.indexOf("\n  update:\n");
  const jobEnd = dependencies.indexOf("\n  push:\n");
  const install = stepIndex(dependencies, "yq is the pinned version");
  const firstUse = dependencies.indexOf("bash scripts/check.sh all");
  assert.ok(install > jobStart && install < jobEnd, "the step is in job update");
  assert.ok(install < firstUse, "the step comes before the step that runs check.sh all");
  assert.match(stepText(dependencies, "yq is the pinned version"), /run: bash scripts\/check\.sh yq-install\s*$/);
});

test("the yq install steps hold no token, secret or env", { todo: "AC-1" }, () => {
  for (const file of [".github/workflows/main.yml", ".github/workflows/dependencies.yml"]) {
    const step = stepText(sourceOf(file), "yq is the pinned version");
    assert.doesNotMatch(step, /secrets\.|token|\benv:|GITHUB_TOKEN/i, `${file}: the step gives yq no token`);
  }
});

test("no workflow repeats the yq version: the pin has one owner, check.sh", { todo: "AC-1" }, () => {
  for (const file of [".github/workflows/main.yml", ".github/workflows/dependencies.yml"]) {
    assert.doesNotMatch(sourceOf(file), /4\.54\.\d+/, `${file} names no yq version`);
  }
});

test("no statement says that yq comes from the runner image", { todo: "AC-6" }, () => {
  const files = [".github/workflows/main.yml", ".github/workflows/dependencies.yml", "AGENTS.md", "scripts/check.sh"];
  for (const file of files) {
    const lines = sourceOf(file).split("\n");
    lines.forEach((line, index) => {
      assert.ok(!(/yq/i.test(line) && /runner image/i.test(line)), `${file}:${index + 1} says yq comes from the runner image: ${line}`);
    });
    // A statement may wrap: look at each pair of neighbouring lines too.
    lines.slice(1).forEach((line, index) => {
      const pair = `${lines[index]} ${line}`;
      assert.ok(!(/\byq\b/i.test(pair) && /runner image/i.test(pair)), `${file}:${index + 1} says yq comes from the runner image: ${pair}`);
    });
  }
});

test("AGENTS.md says the workflow checks use the yq that check.sh yq-install installs", { todo: "AC-6" }, () => {
  assert.match(sourceOf("AGENTS.md").replace(/\s+/g, " "), /yq-install/);
  assert.doesNotMatch(sourceOf("AGENTS.md"), /reads the\s+workflows with yq 4\.54\.1/);
});

test("check.sh lists yq-install in its usage line", { todo: "AC-1" }, () => {
  const result = spawnSync("/bin/bash", [path.join(PROXY, "scripts/check.sh"), "no-such-subcommand"], { cwd: PROXY, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\byq-install\b/);
});
