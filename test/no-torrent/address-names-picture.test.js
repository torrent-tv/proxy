/**
 * @file The address of "what was given" to a viewer names the picture.
 *
 * A viewer outlives the picture: a page that opens a second file keeps its
 * consumer id and its generation. What was given to it for the first picture
 * must never answer a request that names the second one, while a repeat inside
 * the SAME picture is still answered by what answered it first.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Renditions } from "../../services/encode/Renditions.js";
import { OutputCatalog } from "../../services/encode/output/OutputCatalog.js";
import { ViewerRequests } from "../../services/server/ViewerRequests.js";
import { Viewers } from "../../services/viewer/Viewers.js";
import { generationOfRequest, noteGivenOutput } from "../../services/viewer/choices.js";
import { SourceFile } from "../../services/media/SourceFile.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { outputSpec } from "./helpers/output-spec.js";
import { renditionsHost } from "./helpers/renditions.js";

const A = { base: "aaaaaaaa00000001", step: "aaaaaaaa00000002", source: "source-a" };
const B = { base: "bbbbbbbb00000001", step: "bbbbbbbb00000002", source: "source-b" };
const VIEWER = "viewer-1";

function outputOf({ id, file, sourceKey, height = 0 }) {
  const spec = outputSpec({
    sourceKey,
    transcodeVideo: height > 0,
    height,
    width: height > 0 ? Math.round((height * 16) / 9) : 0
  });
  return { id, file, spec, outputKey: spec.toKey(), timeline: { cutGrid: "uniform" }, segmentFormat: fmp4Format, output: { encodeHeight: height } };
}

/**
 * Two pictures of different films in one catalog, one viewer, and steps made
 * per film by the port that creates outputs.
 *
 * @param {{ storedPieceReady?: boolean }} [how]
 */
function twoPictures(how = {}) {
  const outputs = new OutputCatalog();
  const bases = {};
  for (const film of [A, B]) {
    const file = new SourceFile({ sourceKey: film.source, fileIndex: 0, name: `${film.source}.mkv` })
      .learn({ durationSeconds: 600, height: 1080, width: 1920 });
    const base = outputOf({ id: film.base, file, sourceKey: film.source });
    base.variantHeight = 1080;
    outputs.set(film.base, base);
    bases[film.source] = { film, file, base };
  }
  const viewers = new Viewers();
  const renditions = new Renditions(renditionsHost(viewers, {
    outputs,
    viewers,
    viewersOf: (output) => viewers.forOutput(output),
    activeOutputFor: () => bases[A.source].base,
    placeViewerOn: () => {},
    outputTimes: { segmentStartTime: () => 0 },
    storedPieceReady: () => how.storedPieceReady === true,
    headersCompatible: () => ({ compatible: false, differences: ["no header"] }),
    getCachedAudioTracks: () => [],
    createOrGetSession: async (request) => {
      const { film, file } = bases[request.sourceKey];
      const existing = outputs.get(film.step);
      if (existing) {
        return existing;
      }
      const made = outputOf({ id: film.step, file, sourceKey: film.source, height: 720 });
      outputs.set(film.step, made);
      return made;
    },
    disposeSession: async (id) => { outputs.delete(id); },
    planEncodersSoon: () => {},
    viewerLeaves: () => {},
    invalidateWaits: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  }));
  viewers.of(bases[A.source].base, VIEWER).qualityMode = "auto";
  return { renditions, outputs, viewers, bases };
}

test("a segment given for one picture does not answer the same address of another picture", { todo: "AC1" }, async () => {
  const { renditions } = twoPictures({ storedPieceReady: true });
  const first = await renditions.resolveVariantFile(A.base, 720, "segment-00005.mp4", VIEWER, 0);
  assert.equal(first.sessionId, A.step);

  const second = await renditions.resolveVariantFile(B.base, 720, "segment-00005.mp4", VIEWER, 0);

  assert.equal(second.sessionId, B.step, "the second picture is answered by its own output");
  assert.equal(second.recover, undefined, "no stored piece of the first picture is served for it");
});

test("a segment given for one picture does not make the address of another picture lost", { todo: "AC1" }, async () => {
  const { renditions } = twoPictures({ storedPieceReady: false });
  await renditions.resolveVariantFile(A.base, 720, "segment-00005.mp4", VIEWER, 0);

  const second = await renditions.resolveVariantFile(B.base, 720, "segment-00005.mp4", VIEWER, 0);

  assert.equal(second.lost, undefined, "the other picture's address is a new address, not a lost one");
  assert.equal(second.sessionId, B.step);
});

test("a repeat of an address of the same picture is answered by the output that answered first", { todo: "AC2" }, async () => {
  const { renditions } = twoPictures();
  const first = await renditions.resolveVariantFile(A.base, 720, "segment-00005.mp4", VIEWER, 0);

  const repeat = await renditions.resolveVariantFile(A.base, 720, "segment-00005.mp4", VIEWER, 0);

  assert.equal(first.sessionId, A.step);
  assert.equal(repeat.sessionId, A.step);
});

test("a repeat of an address of the same picture whose output has gone is served from the stored piece", { todo: "AC2" }, async () => {
  const { renditions, outputs } = twoPictures({ storedPieceReady: true });
  await renditions.resolveVariantFile(A.base, 720, "segment-00005.mp4", VIEWER, 0);
  const givenKey = outputs.get(A.step).outputKey;
  outputs.delete(A.step);

  const repeat = await renditions.resolveVariantFile(A.base, 720, "segment-00005.mp4", VIEWER, 0);

  assert.deepEqual(repeat, { sessionId: null, recover: { key: givenKey, likeId: A.base } });
});

test("the picture's own route for one picture does not make a request for another picture resolve to the first", { todo: "AC3" }, async () => {
  const { renditions, viewers, outputs } = twoPictures({ storedPieceReady: true });
  const stepOfA = outputOf({ id: A.step, file: outputs.get(A.base).file, sourceKey: A.source, height: 720 });
  outputs.set(A.step, stepOfA);
  const requests = new ViewerRequests({
    outputs: { get: (id) => outputs.get(id) ?? null, variantHeightOf: () => 720 },
    generationOfRequest: (consumerId, stated) => generationOfRequest(viewers, consumerId, stated),
    noteGivenOutput: (...args) => noteGivenOutput(viewers, ...args)
  });
  requests.noteAnsweredDirectly(A.step, VIEWER, 0, "segment-00007.mp4");

  const resolved = await renditions.resolveVariantFile(B.base, 720, "segment-00007.mp4", VIEWER, 0);

  assert.equal(resolved.sessionId, B.step, "answered by the second picture's own output");
  assert.equal(resolved.recover, undefined, "never by the first picture's stored piece");
});
