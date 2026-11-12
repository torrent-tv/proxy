/**
 * @file The page's own append and fragment samples reach the start forecast
 * as the browser's processing of each fragment, and the readiness log line
 * says what was measured (torrent-tv/meta#260).
 *
 * The wiring is real; the source, the film and the viewer's report are
 * given, so nothing encodes and nothing downloads.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { logger } from "../../utils/logger.js";
import { SourceFile } from "../../services/media/SourceFile.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { Output } from "../../services/encode/output/Output.js";
import { outputSpec } from "./helpers/output-spec.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { outputOn } from "./helpers/output.js";

const OUTPUT = "surface:fmt=fmp4:grid=kf@0:video-only:v=0/copy";
const FRAGMENT = "main:0:0:1:4:";
const EMPTY = { bytes: 0, elapsedMs: 0, operations: 0, samples: [] };

/** A manager whose one video output stands at the start of a file held whole. */
function wired(t, id) {
  const built = managerWithOwnStore();
  t.after(built.cleanup);
  const parts = built.manager;
  t.after(() => clearInterval(parts.cleanupTimer));
  const session = outputOn(parts, {
    id,
    key: OUTPUT,
    spec: outputSpec({ cutGrid: "keyframe", audioSeparate: false }),
    dirPath: path.join(built.root, "does-not-exist"),
    file: new SourceFile({ sourceKey: "torrent:abc", fileIndex: 0, name: "video.mkv" })
      .learn({ width: 1920, height: 1080, durationSeconds: 40 }),
    timeline: new Timeline({ boundaries: Array.from({ length: 11 }, (_, index) => index * 4), cutGrid: "keyframe" }),
    segmentFormat: fmp4Format,
    output: new Output({ encodeWidth: 0, encodeHeight: 0, outputFps: 24, softwarePreset: null, applyTonemap: false }),
    transcodeVideo: false,
    transcodeAudio: true,
    audioTrackIndex: 0,
    audioSourceTrackIndex: 0,
    segmentCount: 10,
    progress: { state: "running", processedSeconds: 0, startPositionSeconds: 0 }
  });
  parts.encodeCost.projectedSpeedOf = () => 0.5;
  parts.sourceInputsFor = (_output, index) => [{ sourceId: "torrent:abc:0",
    ranges: [{ start: index * 1e7, end: (index + 1) * 1e7 }] }];
  parts.getSourceStats = async () => {
    const startedAt = performance.now();
    const capture = { owner: "torrent-worker", clock: "performance", clockEpoch: performance.timeOrigin,
      startedAt, completedAt: performance.now(), revision: 1, validity: "valid", unknownReason: null };
    return { fileAvailable: true, downloadSpeed: 50e6, fileOffset: 0, fileLength: 1e8,
      pieceLength: 1 << 20, sourceCapture: capture,
      downloadForecast: { measuredAt: Date.now(), global: true,
        ranges: [{ start: 0, end: 1e8, availableAt: Date.now() }],
        capture: { ...capture, startedAt: performance.now(), completedAt: performance.now() } } };
  };
  return { parts, session };
}

/**
 * The viewer's reading as `Viewer` keeps it: one buffered media fragment of
 * 1000 bytes, parsed in 10 ms, whose appends executed 20 ms on the picture
 * buffer and 40 ms on the sound buffer (50 ms of work: 5e-5 s per byte).
 */
function viewerReading(session, { appendSessionId = session.id, bufferValidity = "valid" } = {}) {
  const at = performance.timeOrigin + performance.now();
  const capture = { owner: "browser", clock: "performance", clockEpoch: performance.timeOrigin,
    startedAt: at, completedAt: at, actionId: session.id, generation: null, revision: 1,
    epoch: "readiness-browser-processing", epochStartedAt: performance.timeOrigin, validity: "valid",
    unknownReason: null };
  const append = executeMs => ({ bytes: 1000, elapsedMs: executeMs + 5, ageMs: 0, fragmentId: FRAGMENT,
    fragmentSequence: 1, partIndex: null, fragmentStartSeconds: 4, executeMs });
  return {
    linkMbps: 100, linkSampleMbps: 100, linkSampleMeasuredAt: Date.now(), positionSeconds: 0,
    bufferedAheadSec: 0, linkCapture: capture,
    bufferCapture: bufferValidity === "valid" ? capture
      : { ...capture, validity: bufferValidity, unknownReason: "missing-or-invalid-browser-capture" },
    appendSessionId, appendEpoch: "page-one", appendEpochStartedAt: 1, appendSnapshotAt: 2,
    appendServiceReceivedAt: Date.now(),
    appendService: {
      video: { init: EMPTY, media: { bytes: 1000, elapsedMs: 25, operations: 1, samples: [append(20)] } },
      audio: { init: EMPTY, media: { bytes: 1000, elapsedMs: 45, operations: 1, samples: [append(40)] } }
    },
    fragmentService: {
      video: { init: EMPTY, media: { bytes: 1000, elapsedMs: 30, operations: 1, samples: [{
        bytes: 1000, elapsedMs: 30, ageMs: 0, fragmentId: FRAGMENT, fragmentSequence: 1, partIndex: null,
        fragmentStartSeconds: 4, parseElapsedMs: 10, bufferingElapsedMs: 60, bufferingAgeMs: 0,
        eventAgesMs: { loadStart: 130, loadFirstByte: 120, loadEnd: 110, parseStart: 110, parseEnd: 100,
          bufferingStart: 70, bufferingEnd: 0 } }] } },
      audio: { init: EMPTY, media: EMPTY }
    }
  };
}

async function readinessFor(t, id, options) {
  const { parts, session } = wired(t, id);
  const viewer = { linkReading: () => viewerReading(session, options) };
  parts.viewers.get = () => viewer;
  return (await parts.viewerRequests.getSessionProgress(session.id, "viewer-one")).playbackReadiness;
}

test("the page's whole append report measures the processing of the track it watches",
  { todo: "AC-10", timeout: 10_000 }, async (t) => {
    const readiness = await readinessFor(t, "aaaaaaaabbbbcccc");

    assert.equal(readiness.browserProcessing?.length, 1);
    assert.equal(readiness.browserProcessing[0].fragments, 1);
    // Both buffers' appends of the fragment: 10 + max(20, 40) ms over 1000 bytes.
    assert.ok(Math.abs(readiness.browserProcessing[0].secondsPerByte - 5e-5) < 1e-12,
      `${readiness.browserProcessing[0].secondsPerByte} seconds per byte`);
  });

test("samples the page measured for another output measure nothing", { todo: "AC-10", timeout: 10_000 },
  async (t) => {
    const readiness = await readinessFor(t, "bbbbbbbbccccdddd", { appendSessionId: "another-output" });

    assert.deepEqual(readiness.browserProcessing?.map(entry => entry.reason), ["browser-processing-unmeasured"]);
  });

test("samples of a report whose buffer capture is not valid measure nothing", { todo: "AC-10", timeout: 10_000 },
  async (t) => {
    const readiness = await readinessFor(t, "ccccccccddddeeee", { bufferValidity: "unknown" });

    assert.deepEqual(readiness.browserProcessing?.map(entry => entry.reason), ["browser-processing-unmeasured"]);
  });

test("the readiness log line states each track's processing rate and sample count",
  { todo: "AC-10", timeout: 10_000 }, async (t) => {
    const lines = [];
    const originalInfo = logger.info;
    logger.info = message => { lines.push(String(message)); };
    t.after(() => { logger.info = originalInfo; });

    await readinessFor(t, "ddddddddeeeeffff");

    const line = lines.find(message => message.startsWith("playback readiness "));
    assert.ok(line, "a readiness line is logged");
    const stated = JSON.parse(line.slice(line.indexOf("{")));
    assert.equal(stated.browserProcessing?.[0]?.fragments, 1);
    assert.ok(Math.abs(stated.browserProcessing[0].secondsPerByte - 5e-5) < 1e-12);
  });
