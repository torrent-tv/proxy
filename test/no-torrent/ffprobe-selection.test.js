/**
 * @file Which ffprobe binary the proxy uses is decided once, at startup, by what
 * the binary can do: its `-sections` output names the section `stream_side_data`.
 * Candidates are tried in order (the bundled binary, then `ffprobe` on PATH).
 * Every process is a fake; no ffprobe is run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { probePackets } from "../../services/media/probe-packets.js";

const SELECTION = new URL("../../services/media/ffprobe-selection.js", import.meta.url).href;
const load = () => import(SELECTION);

/** `ffprobe -sections` of the bundled darwin-arm64 build (4.4.1): it has `stream_side_data_list` and no `stream_side_data`. */
const SECTIONS_WITHOUT = [
  "Sections:",
  "W.. = Section is a wrapper (contains other sections, no local entries)",
  ".A. = Section contains an array of elements of the same type",
  "..V = Section may contain a variable number of fields with variable keys",
  "FLAGS NAME/UNIQUE_NAME",
  "---",
  "W..   root",
  ".A.      streams",
  "...          stream",
  ".A.              side_data_list/stream_side_data_list",
  "...                  side_data",
  ".A.      packets",
  "...          packet",
  ".A.              side_data_list/packet_side_data_list",
  "...                  side_data",
  ""
].join("\n");

/** `ffprobe -sections` of a build that has the section. */
const SECTIONS_WITH = SECTIONS_WITHOUT.replace("...                  side_data\n.A.      packets",
  "...                  side_data/stream_side_data\n.A.      packets");

const BUNDLED = { source: "bundled", binary: "/modules/@ffprobe-installer/darwin-arm64/ffprobe" };
const ON_PATH = { source: "PATH", binary: "ffprobe" };

/**
 * A `run(binary, args)` over a table of what each binary prints. An entry is
 * `{ version, sections, sectionsStatus }`, or an Error the process cannot be
 * started with. Calls are recorded.
 */
function fakeRun(table) {
  const calls = [];
  const run = async (binary, args) => {
    calls.push([binary, args]);
    const entry = table[binary];
    if (entry instanceof Error) throw entry;
    if (args.includes("-version")) return { status: 0, stdout: `ffprobe version ${entry.version} Copyright (c) 2007-2023 the FFmpeg developers\nbuilt with a compiler\n`, stderr: "" };
    if (args.includes("-sections")) return { status: entry.sectionsStatus ?? 0, stdout: entry.sections, stderr: "" };
    throw new Error(`unexpected arguments ${JSON.stringify(args)}`);
  };
  return { run, calls };
}

function fakeLogger() {
  const lines = [];
  const logger = {};
  for (const level of ["debug", "info", "warn", "error"]) logger[level] = (line) => lines.push({ level, line: String(line) });
  return { logger, lines };
}

test("the bundled binary is chosen when its sections name stream_side_data", { todo: "AC-20-B1" }, async () => {
  const { selectFfprobe } = await load();
  const { run } = fakeRun({ [BUNDLED.binary]: { version: "20230721-c2b3861", sections: SECTIONS_WITH } });
  const chosen = await selectFfprobe({ candidates: [BUNDLED, ON_PATH], run, logger: fakeLogger().logger });
  assert.deepEqual(chosen, { source: "bundled", binary: BUNDLED.binary, version: "20230721-c2b3861" });
});

test("a candidate after the chosen one is never run", { todo: "AC-20-B1" }, async () => {
  const { selectFfprobe } = await load();
  const { run, calls } = fakeRun({ [BUNDLED.binary]: { version: "20230721-c2b3861", sections: SECTIONS_WITH }, [ON_PATH.binary]: new Error("must not be run") });
  await selectFfprobe({ candidates: [BUNDLED, ON_PATH], run, logger: fakeLogger().logger });
  assert.deepEqual(calls.map(([binary]) => binary), [BUNDLED.binary, BUNDLED.binary], "the chosen candidate is asked its version and its sections once each");
  assert.ok(calls.some(([, args]) => args.includes("-version")) && calls.some(([, args]) => args.includes("-sections")));
});

test("the binary on PATH is chosen when the bundled one lacks the section", { todo: "AC-20-B1" }, async () => {
  const { selectFfprobe } = await load();
  const { run } = fakeRun({
    [BUNDLED.binary]: { version: "n4.4.1", sections: SECTIONS_WITHOUT },
    [ON_PATH.binary]: { version: "6.1.1", sections: SECTIONS_WITH }
  });
  const chosen = await selectFfprobe({ candidates: [BUNDLED, ON_PATH], run, logger: fakeLogger().logger });
  assert.deepEqual(chosen, { source: "PATH", binary: "ffprobe", version: "6.1.1" });
});

test("a section name that only begins with stream_side_data does not qualify a binary", { todo: "AC-20-B1" }, async () => {
  const { selectFfprobe, FfprobeUnavailableError } = await load();
  const { run } = fakeRun({ [BUNDLED.binary]: { version: "n4.4.1", sections: SECTIONS_WITHOUT } });
  await assert.rejects(selectFfprobe({ candidates: [BUNDLED], run, logger: fakeLogger().logger }), FfprobeUnavailableError);
});

test("the binary on PATH is chosen when the bundled one cannot be run", { todo: "AC-20-B1" }, async () => {
  const { selectFfprobe } = await load();
  const { run } = fakeRun({
    [BUNDLED.binary]: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
    [ON_PATH.binary]: { version: "6.1.1", sections: SECTIONS_WITH }
  });
  const chosen = await selectFfprobe({ candidates: [BUNDLED, ON_PATH], run, logger: fakeLogger().logger });
  assert.equal(chosen.source, "PATH");
});

test("a binary whose -sections exits non-zero does not qualify, whatever it printed", { todo: "AC-20-B1" }, async () => {
  const { selectFfprobe } = await load();
  const { run } = fakeRun({
    [BUNDLED.binary]: { version: "20230721-c2b3861", sections: SECTIONS_WITH, sectionsStatus: 1 },
    [ON_PATH.binary]: { version: "6.1.1", sections: SECTIONS_WITH }
  });
  const chosen = await selectFfprobe({ candidates: [BUNDLED, ON_PATH], run, logger: fakeLogger().logger });
  assert.equal(chosen.source, "PATH");
});

test("when no candidate qualifies one line names each with its version and the missing section, and the prerequisite is declared", { todo: "AC-20-B1" }, async () => {
  const { selectFfprobe, FfprobeUnavailableError } = await load();
  const { run } = fakeRun({
    [BUNDLED.binary]: { version: "n4.4.1", sections: SECTIONS_WITHOUT },
    [ON_PATH.binary]: { version: "4.2.7", sections: "" }
  });
  const { logger, lines } = fakeLogger();
  const error = await selectFfprobe({ candidates: [BUNDLED, ON_PATH], run, logger }).then(() => null, (failure) => failure);
  assert.ok(error instanceof FfprobeUnavailableError, "the proxy declares ffprobe a missing prerequisite");
  assert.equal(lines.length, 1, "one line in all, at any level");
  assert.equal(lines[0].level, "error");
  assert.equal(error.message, lines[0].line, "the thrown message is the logged line");
  for (const part of [BUNDLED.binary, "n4.4.1", ON_PATH.binary, "4.2.7"]) assert.ok(lines[0].line.includes(part), `the line names ${part}`);
  assert.equal(lines[0].line.split("stream_side_data").length - 1, 2, "the missing section is named for each of the two candidates");
});

test("an unrunnable candidate is named in the single line with the reason it could not be run", { todo: "AC-20-B1" }, async () => {
  const { selectFfprobe } = await load();
  const { run } = fakeRun({
    [BUNDLED.binary]: { version: "n4.4.1", sections: SECTIONS_WITHOUT },
    [ON_PATH.binary]: Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" })
  });
  const { logger, lines } = fakeLogger();
  await assert.rejects(selectFfprobe({ candidates: [BUNDLED, ON_PATH], run, logger }));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].line.includes("spawn ffprobe ENOENT"));
});

test("with no candidate at all the prerequisite is declared with one line", { todo: "AC-20-B1" }, async () => {
  const { selectFfprobe, FfprobeUnavailableError } = await load();
  const { run, calls } = fakeRun({});
  const { logger, lines } = fakeLogger();
  await assert.rejects(selectFfprobe({ candidates: [], run, logger }), FfprobeUnavailableError);
  assert.equal(lines.length, 1);
  assert.equal(calls.length, 0);
});

test("the candidates are the bundled binary first and ffprobe on PATH second", { todo: "AC-20-B1" }, async () => {
  const { ffprobeCandidates } = await load();
  assert.deepEqual(ffprobeCandidates({ bundledBinary: "/modules/ffprobe" }), [
    { source: "bundled", binary: "/modules/ffprobe" },
    { source: "PATH", binary: "ffprobe" }
  ]);
});

test("with no bundled binary the only candidate is ffprobe on PATH", { todo: "AC-20-B1" }, async () => {
  const { ffprobeCandidates } = await load();
  assert.deepEqual(ffprobeCandidates({ bundledBinary: null }), [{ source: "PATH", binary: "ffprobe" }]);
});

test("a probe is never started without the binary chosen at startup", { todo: "AC-20-B1" }, () => {
  const spawned = [];
  const silentChild = () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.kill = () => {};
    return child;
  };
  const spawnProcess = (binary) => {
    spawned.push(binary);
    return silentChild();
  };
  assert.throws(() => probePackets({ url: "http://127.0.0.1:9/none", statement: "streams", spawnProcess }), TypeError);
  assert.deepEqual(spawned, [], "no process is started to find a binary per probe");
});
