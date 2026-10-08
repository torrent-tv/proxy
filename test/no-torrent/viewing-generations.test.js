/**
 * @file A viewer's own viewings, and what each request made in one of them
 * holds — roadmap item 97, step 9.
 *
 * The property under all of it: a seek of ONE viewer decides nothing about
 * another viewer's requests, a request made for a viewing its viewer has left
 * is refused before it can cause anything, and an output is not taken away
 * while a response is still being sent from it or a request made against it
 * may still be repeated.
 *
 * Nothing here starts a torrent, a worker or ffmpeg: the routes, the viewer
 * registry and the lifecycle are driven with plain values.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleTranscodeVariantFileGet } from "../../routes/transcode/variant-file/get.js";
import { handleTranscodeAudioFileGet } from "../../routes/transcode/audio-file/get.js";
import { serveSessionFile, statedGenerationOf } from "../../services/server/transcode-session-files.js";
import { Viewers } from "../../services/viewer/Viewers.js";
import { ACCEPT_WINDOW_MS } from "../../services/viewer/Viewer.js";
import {
  acceptsGeneration,
  chooseOutput,
  generationOfRequest,
  givenOutputOf,
  holdForResponse,
  noteGivenOutput
} from "../../services/viewer/choices.js";
import { ViewerRequests } from "../../services/server/ViewerRequests.js";
import { OutputRetention } from "../../services/encode/output/OutputRetention.js";
import { OutputLifecycle } from "../../services/server/OutputLifecycle.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";

const OUTPUT_ID = "1111111122223333";
const OTHER_ID = "4444444455556666";

/**
 * A reply that records what the route answered, with a response underneath
 * that can say it finished, closed or failed.
 *
 * @returns {{ reply: object, sent: { code: number, headers: Record<string, string>, body: unknown } }}
 */
function recordingReply() {
  const sent = { code: 200, headers: {}, body: undefined };
  const raw = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
  const reply = {
    raw,
    code(value) {
      sent.code = value;
      return reply;
    },
    header(name, value) {
      sent.headers[name.toLowerCase()] = String(value);
      return reply;
    },
    send(body) {
      sent.body = body;
      return reply;
    }
  };
  return { reply, sent };
}

/**
 * @param {Record<string, string>} params
 * @param {Record<string, string>} query
 * @returns {object}
 */
function requestOf(params, query) {
  return { params, query, headers: {}, raw: { on() {}, off() {} } };
}

test("a request for a viewing that was left is refused before the step is resolved", async () => {
  const resolved = [];
  const renditions = {
    resolveVariantFile: async (...args) => {
      resolved.push(args);
      return { sessionId: null };
    }
  };
  const viewerRequests = { acceptsRequest: (_consumerId, generation) => generation !== 3 };

  const stale = recordingReply();
  await handleTranscodeVariantFileGet(
    requestOf({ sessionId: OUTPUT_ID, height: "720", fileName: "segment-00005.mp4" }, { consumer: "viewer-a", generation: "3" }),
    stale.reply,
    { renditions, serving: {}, viewerRequests }
  );
  assert.equal(resolved.length, 0, "resolving could make a step and register the viewer on it");
  assert.equal(stale.sent.code, 409);
  assert.equal(stale.sent.headers["retry-after"], undefined);
  assert.equal(stale.sent.body.reason, "request-obsolete");
  assert.equal(stale.sent.body.canRetry, false);

  const current = recordingReply();
  await handleTranscodeVariantFileGet(
    requestOf({ sessionId: OUTPUT_ID, height: "720", fileName: "segment-00005.mp4" }, { consumer: "viewer-a", generation: "4" }),
    current.reply,
    { renditions, serving: {}, viewerRequests }
  );
  assert.equal(resolved.length, 1, "a request of the current viewing is resolved");
  assert.equal(resolved[0][4], 4, "and it is handed the generation it carried");
});

test("a request for a soundtrack of a viewing that was left is refused before it is resolved", async () => {
  const resolved = [];
  const renditions = {
    resolveAudioRenditionFile: async (...args) => {
      resolved.push(args);
      return { sessionId: null };
    }
  };
  const viewerRequests = { acceptsRequest: () => false };
  const { reply, sent } = recordingReply();

  await handleTranscodeAudioFileGet(
    requestOf({ sessionId: OUTPUT_ID, trackIndex: "1", fileName: "segment-00005.mp4" }, { consumer: "viewer-a", generation: "0" }),
    reply,
    { renditions, serving: {}, viewerRequests }
  );

  assert.equal(resolved.length, 0);
  assert.equal(sent.code, 409);
  assert.equal(sent.body.reason, "request-obsolete");
  assert.equal(sent.body.canRetry, false);
});

test("only a stated non-negative integer is a generation", () => {
  assert.equal(statedGenerationOf({ query: { generation: "7" } }), 7);
  assert.ok(Number.isNaN(statedGenerationOf({ query: {} })), "nothing stated");
  assert.ok(Number.isNaN(statedGenerationOf({ query: { generation: "-1" } })));
  assert.ok(Number.isNaN(statedGenerationOf({ query: { generation: "2.5" } })));
  assert.ok(Number.isNaN(statedGenerationOf({ query: { generation: "abc" } })));
});

test("one viewer's seek does not touch another viewer's assignments on a shared output", () => {
  const viewers = new Viewers();
  const shared = { id: OUTPUT_ID, outputKey: "key-shared" };
  viewers.of(shared, "viewer-a");
  viewers.of(shared, "viewer-b");
  noteGivenOutput(viewers, "viewer-a", 0, 720, 5, "key-shared");
  noteGivenOutput(viewers, "viewer-b", 0, 720, 5, "key-shared");
  const seekedAt = Date.now();

  viewers.get("viewer-a").assignments.statedGeneration(1, seekedAt);

  const longAfter = seekedAt + ACCEPT_WINDOW_MS + 1;
  assert.equal(acceptsGeneration(viewers, "viewer-b", 0, longAfter), true, "the other viewer did not seek");
  assert.equal(givenOutputOf(viewers, "viewer-b", 0, 720, 5), "key-shared");

  assert.equal(
    acceptsGeneration(viewers, "viewer-a", 0, seekedAt + 1_000),
    true,
    "a request of the viewing just left, arriving late, is still taken within the window"
  );
  assert.equal(
    givenOutputOf(viewers, "viewer-a", 0, 720, 5),
    "key-shared",
    "and is answered by what answered it, not decided anew"
  );
  assert.equal(
    acceptsGeneration(viewers, "viewer-a", 0, longAfter),
    false,
    "past the window, a request of the viewing left is refused"
  );
});

test("a request that states no generation belongs to the viewer's current one", () => {
  const viewers = new Viewers();
  viewers.of({ id: OUTPUT_ID, outputKey: "key" }, "viewer-a");
  viewers.get("viewer-a").assignments.statedGeneration(3);

  assert.equal(generationOfRequest(viewers, "viewer-a", Number.NaN), 3);
  assert.equal(generationOfRequest(viewers, "viewer-a", 1), 1, "a stated one is kept as stated");
  assert.equal(acceptsGeneration(viewers, "nobody", 0), true, "a viewer not known yet takes everything");
});

test("a response already begun holds its output across a change of viewing, and its release is safe to repeat", async () => {
  const viewers = new Viewers();
  const output = { id: OUTPUT_ID, outputKey: "key-sent" };
  viewers.of({ id: OTHER_ID, outputKey: "key-other" }, "viewer-a");
  const serving = {
    subscribeFileChange: () => ({ changed: new Promise(() => {}), release: () => {} }),
    seekEpoch: () => 0,
    getFileStream: async () => ({ kind: "file", contentType: "video/mp4", stream: "bytes", isPlaylist: false })
  };
  const viewerRequests = {
    holdResponse: (_sessionId, consumerId) => holdForResponse(viewers, consumerId, output.outputKey)
  };
  const { reply, sent } = recordingReply();

  await serveSessionFile(
    requestOf({}, { consumer: "viewer-a" }),
    reply,
    { serving, viewerRequests, sessionId: OUTPUT_ID, fileName: "segment-00005.mp4" }
  );
  assert.equal(sent.body, "bytes", "the fixture must reach sending");

  viewers.get("viewer-a").assignments.statedGeneration(9, Date.now() - 10 * ACCEPT_WINDOW_MS);
  assert.equal(viewers.assignmentsHold(output), true, "the response is still going out");

  reply.raw.emit("finish");
  assert.equal(viewers.assignmentsHold(output), false, "finished, it holds nothing");
  reply.raw.emit("close");
  reply.raw.emit("error", new Error("after the end"));
  assert.equal(viewers.assignmentsHold(output), false, "and the events after it change nothing");
});

test("a response over before it began is released at once", async () => {
  const viewers = new Viewers();
  const output = { id: OUTPUT_ID, outputKey: "key-sent" };
  viewers.of({ id: OTHER_ID, outputKey: "key-other" }, "viewer-a");
  const serving = {
    subscribeFileChange: () => ({ changed: new Promise(() => {}), release: () => {} }),
    seekEpoch: () => 0,
    getFileStream: async () => ({ kind: "file", contentType: "video/mp4", stream: "bytes", isPlaylist: false })
  };
  const viewerRequests = {
    holdResponse: (_sessionId, consumerId) => holdForResponse(viewers, consumerId, output.outputKey)
  };
  const { reply } = recordingReply();
  reply.raw.destroyed = true;

  await serveSessionFile(
    requestOf({}, { consumer: "viewer-a" }),
    reply,
    { serving, viewerRequests, sessionId: OUTPUT_ID, fileName: "segment-00005.mp4" }
  );

  assert.equal(viewers.assignmentsHold(output), false, "no event of it will fire again to release it");
});

test("the picture's own route records its answer under the height it is named after", () => {
  const viewers = new Viewers();
  const picture = {
    id: OUTPUT_ID,
    outputKey: "key-picture",
    spec: { video: {} },
    segmentFormat: fmp4Format
  };
  const soundtrack = {
    id: OTHER_ID,
    outputKey: "key-sound",
    spec: { video: null },
    segmentFormat: fmp4Format
  };
  viewers.of(picture, "viewer-a");
  const byId = new Map([[picture.id, picture], [soundtrack.id, soundtrack]]);
  const requests = new ViewerRequests({
    outputs: { get: (id) => byId.get(id) ?? null, variantHeightOf: () => 1080 },
    generationOfRequest: (consumerId, stated) => generationOfRequest(viewers, consumerId, stated),
    noteGivenOutput: (...args) => noteGivenOutput(viewers, ...args)
  });

  requests.noteAnsweredDirectly(OUTPUT_ID, "viewer-a", 0, "segment-00012.mp4");
  requests.noteAnsweredDirectly(OUTPUT_ID, "viewer-a", 0, "init.mp4");
  requests.noteAnsweredDirectly(OUTPUT_ID, "viewer-a", 0, "index.m3u8");
  requests.noteAnsweredDirectly(OTHER_ID, "viewer-a", 0, "segment-00012.mp4");

  assert.equal(givenOutputOf(viewers, "viewer-a", 0, 1080, 12), "key-picture");
  assert.equal(givenOutputOf(viewers, "viewer-a", 0, 1080, -1), "key-picture", "the init is segment -1");
  const held = viewers.get("viewer-a").assignments.heldKeys();
  assert.equal(held.has("key-sound"), false, "a soundtrack is not a height and records nothing");
  assert.deepEqual([...held], ["key-picture"], "and a playlist records nothing either");
});

/**
 * An output lifecycle whose disposals are recorded instead of carried out:
 * what is checked is WHETHER it disposes, not how.
 *
 * @param {{ viewers: Viewers, outputs: object[] }} setup
 */
function lifecycleOver({ viewers, outputs }) {
  const byId = new Map(outputs.map((output) => [output.id, output]));
  const lifecycle = new OutputLifecycle({
    viewers,
    retention: new OutputRetention(),
    outputNeeded: (key, now) => viewers.assignmentsHold({ outputKey: key }, now) ||
      [...byId.values()].some(output => output.outputKey === key && viewers.stillNeeded(output, now)),
    outputWriting: () => false,
    outputReading: key => viewers.responsesHold(key),
    sessionTtlMs: 0,
    outputs: {
      get: (id) => byId.get(id) ?? null,
      has: (id) => byId.has(id),
      touch() {},
      familyOf: (output) => [output],
      expiredBefore: () => [...byId.keys()],
      values: () => byId.values()
    },
    timelines: { forgetUnused() {} },
    sourceFiles: { forgetUnused() {}, get() {} },
    keyframeTables: { forgetUnused() {} },
    machineBudget: { revise: async () => {}, segmentBytes: () => 0 },
    returns: { describe: () => null },
    segmentStore: { addresses: () => [], inventory: () => [] },
    viewerSegmentsOn: () => []
  });
  const disposed = [];
  lifecycle.disposeSession = async (id) => {
    disposed.push(id);
    byId.delete(id);
  };
  return { lifecycle, disposed };
}

test("an output an assignment holds is kept when its last viewer leaves, and by the idle expiry until it lapses", async () => {
  const viewers = new Viewers();
  const output = { id: OUTPUT_ID, outputKey: "key-held" };
  const elsewhere = { id: OTHER_ID, outputKey: "key-elsewhere" };
  viewers.of(output, "viewer-a");
  // Viewer B moved to another output a moment ago; a request of theirs made
  // against this one may still be repeated.
  viewers.of(elsewhere, "viewer-b");
  noteGivenOutput(viewers, "viewer-b", 0, 720, 5, output.outputKey);
  const { lifecycle, disposed } = lifecycleOver({ viewers, outputs: [output] });

  await lifecycle.releaseSessionConsumer(OUTPUT_ID, "viewer-a", "test");
  assert.deepEqual(disposed, [], "nobody watches it, but an assignment still holds it");

  await lifecycle.cleanupExpired();
  assert.deepEqual(disposed, [], "the idle expiry asks the same assignments");

  viewers.get("viewer-b").assignments.statedGeneration(1, Date.now() - ACCEPT_WINDOW_MS - 1);
  await lifecycle.cleanupExpired();
  assert.deepEqual(disposed, [OUTPUT_ID], "once the window of that viewing has passed, it goes");
});

test("a paused viewer protects its output from idle expiry", async () => {
  // A pause is not a departure, regardless of time since the last file read.
  const viewers = new Viewers();
  const output = { id: OUTPUT_ID, outputKey: "key-paused" };
  viewers.of(output, "viewer-paused");
  const { lifecycle, disposed } = lifecycleOver({ viewers, outputs: [output] });

  await lifecycle.cleanupExpired();

  assert.deepEqual(disposed, []);
});

test("a response already begun holds its output across a change of choice and the viewer leaving that output", () => {
  // Roadmap item 97, step 11: the viewer was given 720p at 2800 and is being
  // moved to 1400. The piece of 2800 already going out must finish, and its
  // output must not be taken away under it — even once the viewer has left it.
  const viewers = new Viewers();
  const at2800 = { id: OUTPUT_ID, outputKey: "key-720-2800" };
  const at1400 = { id: OTHER_ID, outputKey: "key-720-1400" };
  viewers.of(at2800, "viewer-a");
  viewers.of(at1400, "viewer-a");
  chooseOutput(viewers, "viewer-a", 720, at2800.outputKey);
  const release = holdForResponse(viewers, "viewer-a", at2800.outputKey);

  chooseOutput(viewers, "viewer-a", 720, at1400.outputKey);
  viewers.leaves(at2800, "viewer-a");

  assert.equal(viewers.forOutput(at2800).size, 0, "nobody is watching it any more");
  assert.equal(viewers.stillNeeded(at2800), true, "but the response being sent from it holds it");
  release();
  assert.equal(viewers.stillNeeded(at2800), false, "and once it is finished, nothing does");
});

test("the step route answers what the rule decided: unavailable, lost, or the stored piece", async () => {
  const viewerRequests = {
    acceptsRequest: () => true,
    holdResponseForKey: () => () => {}
  };
  const route = async (resolved, serving = {}) => {
    const { reply, sent } = recordingReply();
    await handleTranscodeVariantFileGet(
      requestOf({ sessionId: OUTPUT_ID, height: "720", fileName: "segment-00005.mp4" }, { consumer: "viewer-a", generation: "0" }),
      reply,
      { renditions: { resolveVariantFile: async () => resolved }, serving, viewerRequests }
    );
    return sent;
  };

  const unavailable = await route({ sessionId: null, unavailable: { reason: "no limit fits", figures: { verdict: "does not fit" } } });
  assert.equal(unavailable.code, 409);
  assert.equal(unavailable.body.outcome, "output-unavailable");
  assert.equal(unavailable.body.figures.verdict, "does not fit", "the figures travel to the page");

  const lost = await route({ sessionId: null, lost: { reason: "the output that answered it has gone" } });
  assert.equal(lost.code, 409);
  assert.equal(lost.body.outcome, "assignment-lost", "not a retry: the same request would be answered the same way");

  const stored = await route(
    { sessionId: null, recover: { key: "gone-key", likeId: OUTPUT_ID } },
    { storedPieceOf: async () => ({ kind: "file", stream: "stored-bytes", contentType: "video/mp4", isPlaylist: false }) }
  );
  assert.equal(stored.body, "stored-bytes", "the very piece that was given");
  assert.equal(stored.headers["content-type"], "video/mp4");

  const vanished = await route(
    { sessionId: null, recover: { key: "gone-key", likeId: OUTPUT_ID } },
    { storedPieceOf: async () => null }
  );
  assert.equal(vanished.body.outcome, "assignment-lost", "a stored piece that went meanwhile is a lost address");
});
