/**
 * @file A failed run ends an output's production only on a terminal input
 * fact (torrent-tv/meta#341).
 *
 * Field 2026-11-09: the only run of an output ended `EXITED_SHORT` with no
 * input failure recorded and no terminal input, the plan was already starting
 * the next run, and the request for segment-00188 was answered 500. What is
 * checked: with an encode-input owner present, such an ending leaves the output
 * `IDLE`, a missing segment is held and served once a later run publishes it,
 * and the line `production goes on` is said once; a terminal input fact
 * (`InputFailures.reason`, `EncodeInputs.failureOf`) still answers 500
 * `canRetry: false`, without that line.
 *
 * Nothing here reaches a torrent or an encoder: the encode-input owner is a
 * fake, each run's process is a fake, and a published segment is a file
 * written under its served name.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { ENCODE_RUN_STATE } from "../../services/encode/encode-run-state.js";
import { EncodeRun } from "../../services/encode/EncodeRun.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { serveSessionFile, waitForRequestedFile } from "../../services/server/transcode-session-files.js";
import { logger } from "../../utils/logger.js";
import { fakeEncodeInputs } from "./helpers/admitted-input.js";
import { fakeProcess, silentLogger } from "./helpers/encode-run.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { outputOn } from "./helpers/output.js";
import { outputSpec } from "./helpers/output-spec.js";
import { untilWatchIsLive } from "./helpers/store-watch.js";

const SESSION_ID = "3410000000000341";
const OUTPUT_KEY = "production-goes-on:fmt=fmp4:grid=uniform:video-only:v=0/copy";
const GOES_ON = /^encode: run #3\.\.#4 of production-goes-on:fmt=fmp4:grid=uniform:video-only:v=0\/copy ended ENDED_FAILED \(.*\); production goes on — no input failure ends it, so requests for its pieces stay held$/;

/**
 * One output whose segments #3 and #4 are not on disk, with an encode-input
 * owner, a viewer, and the lines it says recorded.
 *
 * @param {import("node:test").TestContext} t
 * @param {{ failureOf?: (output: object) => object | null }} [inputs]
 */
function anOutput(t, { failureOf = () => null } = {}) {
  const said = [];
  mock.method(logger, "info", line => said.push(line));
  mock.method(logger, "warn", line => said.push(line));
  t.after(() => mock.restoreAll());
  const { manager, root } = managerWithOwnStore({ planless: true, encodeInputs: { ...fakeEncodeInputs(), failureOf } });
  const session = outputOn(manager, {
    id: SESSION_ID,
    key: OUTPUT_KEY,
    spec: outputSpec({ transcodeVideo: false, cutGrid: "uniform" }),
    timeline: new Timeline({ boundaries: [0, 12.5, 25, 37.5, 50, 62.5], cutGrid: "uniform" })
  });
  manager.viewers.of(session, "viewer-a").moveTo(0);
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(root, { recursive: true, force: true });
  });
  return { manager, session, said };
}

/**
 * The output's only run, over #3..#4, on a fake process.
 *
 * @param {{ inputKeyOfHead?: string }} [options] - The input it was given,
 *   holding its first piece alone, so its failure is recorded against it.
 */
function itsOnlyRun(manager, session, { inputKeyOfHead = null } = {}) {
  const child = fakeProcess();
  const run = new EncodeRun({ address: OUTPUT_KEY, encoder: { name: "libx264", kind: "software" }, from: 3, to: 4,
    buildArgs: () => [], spawn: () => child, logger: silentLogger, lastSegmentIndex: () => 4,
    because: "a check asked for it",
    onEnded: ended => manager.encodeRuns.noteRunEnded(session, run, ended) });
  if (inputKeyOfHead) run.admittedInputKeys = new Map([[3, inputKeyOfHead]]);
  manager.encodeOrchestrator.adopt(OUTPUT_KEY, run);
  return child;
}

/** Until the store holds a wait for the output: a wake checked before the wait exists proves nothing. */
async function untilHeld(manager) {
  while (manager.segmentStore.waitingFor(OUTPUT_KEY) < 1) await setImmediate();
}

/** Write a segment as a run publishes it: under its served name. */
async function publish(session, index) {
  await writeFile(path.join(session.dirPath, fmp4Format.segmentFileName(index)), Buffer.alloc(256, 0x5a));
}

/** Ask for a segment as the route does, and record what it answers. */
async function served(manager, fileName) {
  const req = { id: "check", raw: new EventEmitter(), headers: {}, query: {} };
  const raw = new EventEmitter();
  const reply = { raw, status: 200, headers: {}, body: undefined,
    code(status) { this.status = status; return this; },
    header(name, value) { this.headers[name] = value; return this; },
    send(body) { this.body = body; return this; } };
  await serveSessionFile(req, reply, { serving: manager.serving, viewerRequests: manager.viewerRequests,
    sessionId: SESSION_ID, fileName });
  reply.body?.destroy?.();
  return reply;
}

test("the only run ending short with no input failure leaves the output idle", { timeout: 10_000 }, async (t) => {
  const { manager, session } = anOutput(t);
  itsOnlyRun(manager, session).exit(0);
  assert.equal(manager.encodeRuns.runStateOf(session), ENCODE_RUN_STATE.IDLE);
});

test("the only run ending short with no input failure has not failed the output", { timeout: 10_000 }, async (t) => {
  const { manager, session } = anOutput(t);
  itsOnlyRun(manager, session).exit(0);
  assert.equal(manager.encodeRuns.hasFailed(session), false);
});

test("a request held while the only run ends short is served when a later run publishes the segment", { timeout: 10_000 }, async (t) => {
  const { manager, session } = anOutput(t);
  await untilWatchIsLive(manager.segmentStore, OUTPUT_KEY, session.dirPath);
  const child = itsOnlyRun(manager, session);
  const held = waitForRequestedFile({}, {}, manager.serving, SESSION_ID, "segment-00003.mp4", "viewer-a");
  await untilHeld(manager);
  child.exit(0);
  // The first answer a wait gives is its answer: a failure given at the ending
  // would be what it returns, whatever is published after.
  await publish(session, 3);
  const answer = await held;
  answer.stream?.destroy?.();
  assert.equal(answer.kind, "file", `the held request was answered ${answer.kind}: ${answer.message ?? ""}`);
});

test("a request after the only run ended short is held, not failed, and served once the segment is published", { timeout: 10_000 }, async (t) => {
  const { manager, session } = anOutput(t);
  await untilWatchIsLive(manager.segmentStore, OUTPUT_KEY, session.dirPath);
  itsOnlyRun(manager, session).exit(0);
  const answering = served(manager, "segment-00003.mp4");
  await untilHeld(manager);
  await publish(session, 3);
  const reply = await answering;
  assert.deepEqual({ status: reply.status, body: reply.status === 200 ? "the segment" : reply.body },
    { status: 200, body: "the segment" });
});

test("a single-piece input that failed still ends production with 500 and no retry", { timeout: 10_000 }, async (t) => {
  const { manager, session } = anOutput(t);
  itsOnlyRun(manager, session, { inputKeyOfHead: "input-of-3" }).exit(1);
  assert.equal(manager.encodeRuns.runStateOf(session), ENCODE_RUN_STATE.ENDED_FAILED, "the fixture must record the input failure");
  const reply = await served(manager, "segment-00003.mp4");
  assert.deepEqual([reply.status, reply.body?.canRetry], [500, false]);
});

test("a terminal input still ends production with 500 and no retry", { timeout: 10_000 }, async (t) => {
  const terminal = { kind: "terminal", reason: "source-input-exceeds-memory-capacity", message: "one piece is larger than memory" };
  const { manager, session } = anOutput(t, { failureOf: output => output.id === SESSION_ID ? terminal : null });
  itsOnlyRun(manager, session).exit(0);
  assert.equal(manager.encodeRuns.runStateOf(session), ENCODE_RUN_STATE.ENDED_FAILED);
  const reply = await served(manager, "segment-00003.mp4");
  assert.deepEqual([reply.status, reply.body?.canRetry], [500, false]);
});

test("a failed run that leaves production going says so once", { timeout: 10_000 }, async (t) => {
  const { manager, session, said } = anOutput(t);
  itsOnlyRun(manager, session).exit(0);
  assert.equal(said.filter(line => GOES_ON.test(line)).length, 1, `the lines were:\n${said.join("\n")}`);
});

test("a failed run whose single-piece input failed does not say production goes on", { timeout: 10_000 }, async (t) => {
  const { manager, session, said } = anOutput(t);
  itsOnlyRun(manager, session, { inputKeyOfHead: "input-of-3" }).exit(1);
  assert.ok(said.some(line => line.startsWith("encode: unchanged input will not be retried")), "the fixture must record the input failure");
  assert.deepEqual(said.filter(line => line.includes("production goes on")), []);
});

test("a failed run of an output with a terminal input does not say production goes on", { timeout: 10_000 }, async (t) => {
  const terminal = { kind: "terminal", reason: "source-input-exceeds-memory-capacity", message: "one piece is larger than memory" };
  const { manager, session, said } = anOutput(t, { failureOf: output => output.id === SESSION_ID ? terminal : null });
  itsOnlyRun(manager, session).exit(0);
  assert.deepEqual(said.filter(line => line.includes("production goes on")), []);
});
