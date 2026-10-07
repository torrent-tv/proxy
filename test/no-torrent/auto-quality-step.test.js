/**
 * @file The automatic quality step: what the proxy does when this machine, or
 * the viewer's link, cannot carry the picture it is producing.
 *
 * The rule these tests exist to pin is one sentence long: THE SIZE OF THE
 * PICTURE IS NEVER REWRITTEN UNDERNEATH A RUNNING SESSION. The fMP4 init
 * segment is fetched once, by `#EXT-X-MAP`, and `avc1` keeps SPS and PPS in it
 * rather than in the fragments — so a run that changes the size produces
 * fragments the decoder cannot read, silently, with no layer reporting an
 * error. Measured 2026-08-21 on two files: one browser reported
 * `size=1280x720` for three and a half minutes over macroblock garbage, the
 * other errored on the first mismatched fragment and sat at `size=0x0`.
 *
 * A change of resolution is a change of VARIANT. The proxy asks only a viewer
 * in automatic mode, and the request travels only in that viewer's progress
 * report.
 */

import test from "node:test";
import { recordViewerReport } from "../../services/viewer/report-intake.js";
import { fakeProcess as fakeEncoder, measureSpeed, startRunOn } from "./helpers/encode-run.js";
import assert from "node:assert/strict";
import { SourceFile } from "../../services/media/SourceFile.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { managerWithOwnStore } from "./helpers/manager.js";
import { Output } from "../../services/encode/output/Output.js";
import { qualityStateOf } from "../../services/encode/quality/OutputQualityState.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { softwareDescriptor, maxrateKbpsFor, nominalKbpsFor } from "../../services/encode/hwaccel.js";
import { softwareRateControlFor } from "../../services/encode/args.js";
import { readVideoSampleSize } from "../../services/encode/segment-formats/mp4-boxes.js";
import { outputSpec } from "./helpers/output-spec.js";

const BASE_ID = "aaaaaaaabbbbcccc";
const SEGMENT_SECONDS = 4;


/**
 * A session shaped like a live one, encoding 720p of a 1080p source.
 *
 * @param {{ dirPath: string, transcodeVideo?: boolean, cutGrid?: string }} params
 *   `cutGrid` goes into the file's cut table; left out, it is what production
 *   builds for this branch.
 * @returns {object}
 */
function fakeSession({ dirPath, transcodeVideo = true, cutGrid = transcodeVideo ? "uniform" : "keyframe" }) {
  return {
    spec: outputSpec({ transcodeVideo, cutGrid }),
    id: BASE_ID,
    dirPath,
    // Where this file is cut, held by the file. A fixture that stated it
    // on the session was describing what production no longer does.
    //
    // The grid travels in here and nowhere else: a copy can only be cut where
    // the source already has a keyframe, so this is what decides whether the
    // stream publishes variants at all, and `#publishesVariants` reads it off
    // the table. The default is what production builds — a keyframe grid only
    // where one was read, which is the copy.
    timeline: new Timeline({
      boundaries: Array.from({ length: 101 }, (_, index) => index * SEGMENT_SECONDS),
      cutGrid
    }),
    state: "ready",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }).learn({ width: 1920, height: 1080, durationSeconds: 400 }),
    // An ordinary session reads its own file, and its sound is inside it. The
    // three differ only for a soundtrack shipped as a file of its own.
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    runs: new Set(),
    runState: "running",
    runSerial: 1,
    lastError: "",
    consumers: new Set(),
    segmentFormat: fmp4Format,
    transcodeVideo,
    transcodeAudio: true,
    audioOnly: false,
    audioTrackIndex: 0,
    // The shape this output is encoded AS, decided once for the output.
    output: new Output({
      encodeWidth: transcodeVideo ? 1280 : 0,
      encodeHeight: transcodeVideo ? 720 : 0,
      outputFps: 24,
      softwarePreset: null,
      applyTonemap: false
    }),
    encodeRunGeneration: 0,
    usesExplicitCuts: false,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    progress: { state: "running", processedSeconds: 40, startPositionSeconds: 0 }
  };
}

/**
 * @param {{ transcodeVideo?: boolean, cutGrid?: string, softwarePresetBenchmark?: object[] }} [options]
 *   `softwarePresetBenchmark` is the host's startup measurement, read through
 *   the encoder in use and not assigned afterwards.
 * @returns {Promise<{ manager: object, session: object, dirPath: string, restarts: number[] }>}
 */
async function managerWithSession({ transcodeVideo = true, cutGrid, softwarePresetBenchmark } = {}) {
  // Its own store root — see `helpers/manager.js` for what sharing one cost.
  const { manager } = managerWithOwnStore({ softwarePresetBenchmark });
  // ADDRESSED THE WAY PRODUCTION ADDRESSES IT: a session's segments live in the
  // store's directory for its OUTPUT, and what it has produced is asked of the
  // store by that same key. A fixture with a directory of its own and no key
  // describes a proxy that no longer exists — the observed bitrate the link
  // budget reads would then be taken from files nothing can find.
  const outputKey = `auto-quality:fmt=fmp4:grid=${transcodeVideo ? "uniform" : "kf@0"}:video-only:v=0/${transcodeVideo ? "enc/libx264/1280x720@24/-/none/vbv=-" : "copy"}`;
  manager.segmentStore.useFormat(outputKey, fmp4Format);
  const dirPath = manager.segmentStore.directoryFor(outputKey);
  // A software host: the budget's own precondition.
  // A fully-downloaded file, so nothing here is ever read as download-bound —
  // the distinction is tested elsewhere and would only obscure these.
  manager.getSourceStats = async () => ({
    downloadSpeed: 10e6,
    fileProgress: 1,
    fileLength: 4e9
  });
  const session = fakeSession({ dirPath, transcodeVideo, cutGrid });
  session.outputKey = outputKey;
  manager.outputs.set(BASE_ID, session);
  manager.viewers.of(session, "viewer").qualityMode = "auto";
  // A run that states its speed, as every real one does from its first
  // seconds, and covers the whole film to its last segment, as the plan gives a
  // run: without a speed the plan cannot tell arrangements apart and takes the
  // encoder away, and with an open end it moves the run to a bounded one —
  // which starts a real ffmpeg in the output's directory, and on Windows that
  // directory then cannot be removed while the process lives.
  const run = startRunOn(session, { process: fakeEncoder(), speedX: 1, to: session.timeline.segmentCount - 1, producing: false });
  manager.encodeOrchestrator.adopt(outputKey, run);
  return { manager, session, dirPath };
}

/**
 * Produced segments of a known size, so the observed stream bitrate the link
 * check compares against is a real reading of real files.
 *
 * @param {object} session
 * @param {number} bytesEach
 * @returns {Promise<void>}
 */
/**
 * This viewer's page reports a buffer that falls a second per second over two
 * segments' time, on the link named: what, on its trend, runs dry before
 * another output could have the piece they need (roadmap item 98).
 *
 * @param {object} viewer
 * @param {number} linkMbps
 * @returns {void}
 */
function drainingReports(viewer, linkMbps) {
  const now = Date.now();
  for (const [ago, held] of [[8_000, 9], [4_000, 5], [0, 1.5]]) {
    viewer.report({ linkMbps, bufferedAheadSec: held, positionSeconds: 40, playing: true }, now - ago);
  }
}

/**
 * This viewer's page reports a buffer that grows, on the link named.
 *
 * @param {object} viewer
 * @param {number | null} linkMbps - Null when the page has not measured it.
 * @returns {void}
 */
function fillingReports(viewer, linkMbps) {
  const now = Date.now();
  for (const [ago, held] of [[8_000, 40], [4_000, 50], [0, 60]]) {
    viewer.report({ linkMbps, bufferedAheadSec: held, positionSeconds: 40, playing: true }, now - ago);
  }
}

async function produceSegments(session, bytesEach) {
  // Where the run in force writes.
  const runDir = session.dirPath;
  await mkdir(runDir, { recursive: true });
  for (let index = 0; index < 4; index += 1) {
    await writeFile(
      path.join(runDir, session.segmentFormat.segmentFileName(index)),
      Buffer.alloc(bytesEach)
    );
  }
}

test("a picture that cannot be kept up with is asked for as another VARIANT, and its size is left alone", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });

  const sizeBefore = `${session.encodeWidth}x${session.encodeHeight}`;
  // Below realtime over its own working time, and the viewer's buffer runs
  // dry on its trend although their link carries the stream.
  measureSpeed([...session.runs][0], 0.7);
  drainingReports(manager.viewers.get("viewer"), 80);

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.equal(
    `${session.encodeWidth}x${session.encodeHeight}`,
    sizeBefore,
    "the size the init segment describes must survive the step — that is the whole fault"
  );
  assert.ok(manager.viewers.get("viewer").qualityAsk, "the step is a request to the AUTO viewer to move variant");
  assert.ok(
    manager.viewers.get("viewer").qualityAsk.height < 720,
    `a step DOWN, and 720p was on screen (asked for ${manager.viewers.get("viewer").qualityAsk?.height}p)`
  );
});

test("a manual viewer is never sent an automatic quality request", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });
  manager.viewers.get("viewer").qualityMode = "manual";
  measureSpeed([...session.runs][0], 0.7);
  drainingReports(manager.viewers.get("viewer"), 80);

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.equal(manager.viewers.get("viewer").qualityAsk, null);
  const progress = await manager.viewerRequests.getSessionProgress(BASE_ID, "viewer");
  assert.equal(progress.requestedHeight, 0);
});

test("the request reaches the browser in the progress report, and stops once the viewer is there", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });

  manager.viewers.get("viewer").qualityAsk = { height: 480, at: Date.now(), reason: "measured" };
  const asked = await manager.viewerRequests.getSessionProgress(BASE_ID, "viewer");
  assert.equal(asked.requestedHeight, 480, "the request travels with every progress report");

  // The player moved: the variant it is now watching IS the height asked for.
  session.variantHeight = 480;
  const answered = await manager.viewerRequests.getSessionProgress(BASE_ID, "viewer");
  assert.equal(answered.requestedHeight, 0, "a request the viewer has answered is not repeated");
  assert.equal(manager.viewers.get("viewer").qualityAsk, null, "and it is let go of, not merely hidden");
});

test("a request stands while its conditions hold, and the next report that does not ask for it lets it go", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });

  // Asked when their buffer was running dry; no chosen time ends it.
  manager.viewers.get("viewer").qualityAsk = { height: 480, at: Date.now() - 120_000, reason: "measured" };
  const standing = await manager.viewerRequests.getSessionProgress(BASE_ID, "viewer");
  assert.equal(standing.requestedHeight, 480, "two minutes on, it still stands: nothing has said otherwise");

  // Their next report shows a buffer that grows: what it was asked for is gone.
  // The machine has no room to spare, so nothing else is asked in its place.
  measureSpeed([...session.runs][0], 0.9);
  fillingReports(manager.viewers.get("viewer"), null);
  await manager.quality.noteViewerReported(session.id, "viewer");

  const progress = await manager.viewerRequests.getSessionProgress(BASE_ID, "viewer");
  assert.equal(progress.requestedHeight, 0);
  assert.equal(manager.viewers.get("viewer").qualityAsk, null, "let go by the judgement that did not repeat it");
});

test("a request the next report asks for again stands", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });
  measureSpeed([...session.runs][0], 0.7);
  drainingReports(manager.viewers.get("viewer"), 80);
  await manager.quality.noteViewerReported(session.id, "viewer");
  const asked = manager.viewers.get("viewer").qualityAsk;
  assert.ok(asked, "the machine cannot keep up and the buffer runs dry");

  drainingReports(manager.viewers.get("viewer"), 80);
  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.equal(manager.viewers.get("viewer").qualityAsk, asked, "the same request, not let go and not made again");
});

test("a COPIED picture is never asked to slow its encoder, because it has none", async (t) => {
  const { manager, session, dirPath } = await managerWithSession({ transcodeVideo: false });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });

  // Whatever this reading says, a copy has no encoder to make cheaper: moving
  // the viewer to a RE-ENCODED rung costs the machine more, not less.
  measureSpeed([...session.runs][0], 0.4);
  drainingReports(manager.viewers.get("viewer"), 80);

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.equal(manager.viewers.get("viewer").qualityAsk, null, "the copy path's lever is the viewer's link, not the CPU");
});

test("the output's own rate control is what reaches ffmpeg, and nothing about the size moves with it", () => {
  // Two limits are two outputs (roadmap item 97, step 10): the figures are
  // read off the output's identity and handed to the encoder as they are. The
  // level is the nominal output's, so every limit at one size declares the
  // same one.
  const nominal = softwareRateControlFor({ width: 1280, height: 720, fps: 24 });
  const lower = softwareRateControlFor({ width: 1280, height: 720, fps: 24, capKbps: 1200 });
  const build = (rateControl) => softwareDescriptor().buildVideoArgs({
    targetWidth: 1280,
    targetHeight: 720,
    segmentDurationSec: 4,
    fps: 24,
    rateControl
  });
  const atNominal = build(nominal);
  const atLower = build(lower);

  assert.equal(atNominal[atNominal.indexOf("-maxrate") + 1], `${maxrateKbpsFor(nominalKbpsFor({ width: 1280, height: 720 }))}k`);
  assert.equal(atLower[atLower.indexOf("-maxrate") + 1], `${maxrateKbpsFor(1200)}k`);
  assert.equal(lower.level, nominal.level, "a lower limit is declared at the nominal output's level");
  assert.equal(atLower[atLower.indexOf("-level:v") + 1], nominal.level);
  assert.deepEqual(
    atNominal.slice(0, atNominal.indexOf("-maxrate")),
    atLower.slice(0, atLower.indexOf("-maxrate")),
    "the scale filter, the codec and the preset are untouched by the limit"
  );
  assert.equal(build(null).includes("-maxrate"), false, "an output that states no limit is given none");
  assert.throws(
    () => softwareRateControlFor({ width: 1280, height: 720, fps: 24, capKbps: nominalKbpsFor({ width: 1280, height: 720 }) + 1 }),
    RangeError,
    "a limit above the size's own is refused, not lowered"
  );
});

test("the size an init segment describes is read from the init, not assumed", () => {
  // A minimal moov/trak/mdia/minf/stbl/stsd with one avc1 entry. Built here
  // rather than taken from a fixture so the offsets under test are the ones
  // ISO/IEC 14496-12 states, and a fixture cannot quietly encode a mistake.
  const avc1 = Buffer.alloc(8 + 8 + 16 + 4);
  avc1.writeUInt32BE(avc1.length, 0);
  avc1.write("avc1", 4, "latin1");
  avc1.writeUInt16BE(960, 32);
  avc1.writeUInt16BE(540, 34);

  const stsd = Buffer.concat([Buffer.alloc(8 + 8), avc1]);
  stsd.writeUInt32BE(stsd.length, 0);
  stsd.write("stsd", 4, "latin1");
  stsd.writeUInt32BE(1, 12); // entry_count

  const wrap = (type, payload) => {
    const box = Buffer.alloc(8 + payload.length);
    box.writeUInt32BE(box.length, 0);
    box.write(type, 4, "latin1");
    payload.copy(box, 8);
    return box;
  };
  const init = wrap("moov", wrap("trak", wrap("mdia", wrap("minf", wrap("stbl", stsd)))));

  assert.deepEqual(readVideoSampleSize(init), { width: 960, height: 540 });
  assert.equal(readVideoSampleSize(Buffer.alloc(0)), null);
});

test("a COPIED picture too thick for the viewer's link is asked for as a smaller VARIANT", async (t) => {
  const { manager, session, dirPath } = await managerWithSession({ transcodeVideo: false });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });

  // Four seconds of segment at 2 MB is ~4 Mbit/s of stream. The viewer reports
  // a link that cannot carry it and a buffer that is running dry.
  await produceSegments(session, 2_000_000);
  drainingReports(manager.viewers.of(session, "viewer"), 1.0);

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.ok(
    manager.viewers.get("viewer").qualityAsk,
    "a copy has no encoder to bound, so the only way to send fewer bits is another rendering of the film"
  );
  assert.equal(manager.viewers.get("viewer").qualityAsk.urgent, true, "their buffer runs dry first: no cushion is waited for");
  assert.ok(manager.viewers.get("viewer").qualityAsk.height < 1080, `a step down (asked for ${manager.viewers.get("viewer").qualityAsk?.height}p)`);
});

test("with two viewers each link decides for its own viewer, not the worst for both", async (t) => {
  const { manager, session, dirPath } = await managerWithSession({ transcodeVideo: false });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });

  await produceSegments(session, 2_000_000);
  // One viewer is comfortable and reported LAST, which under a single field was
  // the whole of what the budget saw. The other cannot carry the stream and is
  // running dry.
  manager.viewers.of(session, "thin").qualityMode = "auto";
  drainingReports(manager.viewers.of(session, "thin"), 1.0);
  manager.viewers.of(session, "fat").qualityMode = "auto";
  fillingReports(manager.viewers.of(session, "fat"), 80);

  await manager.quality.noteViewerReported(session.id, "thin");
  await manager.quality.noteViewerReported(session.id, "fat");

  assert.ok(
    manager.viewers.get("thin").qualityAsk,
    "the viewer who cannot keep up is asked, whichever of them reported most recently"
  );
  assert.equal(
    manager.viewers.get("fat").qualityAsk,
    null,
    "and ONLY them: a thin link is its owner's, and the viewer beside them keeps their picture"
  );
});

test("a reading stops counting when the person leaves, not when it gets old", async (t) => {
  const { manager, session, dirPath } = await managerWithSession({ transcodeVideo: false });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });

  await produceSegments(session, 2_000_000);
  // A LINK READING DOES NOT EXPIRE. It is the last thing known about that link,
  // and how fast a link is does not change because nobody measured it for a
  // minute — the page keeps its own last figure for the same reason. What ends
  // a reading is the person leaving, which is presence, and presence is the
  // connection: silence removes nobody (2026-09-05, a soundtrack's encoder
  // stopped because those two questions had one answer).
  const gone = manager.viewers.of(session, "gone");
  gone.qualityMode = "auto";
  gone.report({ linkMbps: 1.0, bufferedAheadSec: 1.5, positionSeconds: 40, playing: true }, Date.now() - 120_000);
  gone.gone = true;
  recordViewerReport({
    outputs: manager.outputs,
    viewers: manager.viewers,
    sessionId: session.id,
    report: { linkMbps: 80, bufferedAheadSec: 60, consumerId: "here", positionSeconds: 40 }
  });
  manager.viewers.get("here").qualityMode = "auto";

  await manager.quality.noteViewerReported(session.id, "here");

  assert.equal(manager.viewers.forOutput(session).size, 3, "the viewer is still known — silence is not leaving");
  // Their reading is not deleted anywhere: it is simply not theirs to give any
  // more, because they are not here. Nothing walks it for a decision.
  assert.equal(
    manager.viewers.get("gone").linkReading()?.linkMbps,
    1.0,
    "their last reading stands as the last thing known about that link"
  );
  assert.equal(manager.viewers.get("here").qualityAsk, null, "the viewer who is here can carry the picture");
});

test("the way BACK UP exists, one rung at a time", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });

  // The viewer is on 480p, the machine makes it ahead of realtime over its own
  // working time, and their buffer grows and holds more than another output
  // takes to be ready. No window has to pass: every term is measured.
  session.variantHeight = 480;
  session.encodeWidth = 854;
  session.encodeHeight = 480;
  measureSpeed([...session.runs][0], 2.4);
  // What another output takes to be ready here, computed as the proxy computes
  // it: this mode's speed as the encoding layer has learned it, and the wait
  // for a first output this host was measured to need — the picture's first
  // segment on the addon host, field 2026-08-31.
  qualityStateOf(session).lastAloneSpeed = 2.4;
  manager.encodeOrchestrator.noteStartupCosts({ firstByteWaitSec: 8.4, killCostSec: 0 });
  // Their link is not measured here: what is under test is the room, and a
  // measured link would also weigh a soundtrack this fixture states no rate for.
  fillingReports(manager.viewers.get("viewer"), null);

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.ok(manager.viewers.get("viewer").qualityAsk, "for most of this project's life there was no step up at all");
  assert.equal(
    manager.viewers.get("viewer").qualityAsk.height,
    540,
    "one rung at a time: the lowest height above the one on screen, never above the source"
  );
});

test("a re-encoded picture too thick for the viewer's link is asked for as a smaller VARIANT, and its output is left as it is", async (t) => {
  // The limit on a picture's bitrate is part of the output now, so a thin link
  // no longer lowers the limit of the output every viewer of it is watching.
  // Until each viewer is served an output of their own (roadmap item 97, steps
  // 11-12), the one lever is a lower height, asked of a viewer in AUTO.
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });
  const keyBefore = session.outputKey;

  await produceSegments(session, 2_000_000);
  manager.viewers.of(session, "viewer").qualityMode = "auto";
  drainingReports(manager.viewers.of(session, "viewer"), 1.0);

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.ok(manager.viewers.get("viewer").qualityAsk, "the viewer is asked to move to a smaller variant");
  assert.equal(session.outputKey, keyBefore, "and the output they were on is not altered under anybody");
});

test("a stream that publishes no variants is left alone, and said so once", async (t) => {
  const { manager, session, dirPath } = await managerWithSession({
    transcodeVideo: false,
    // A copy whose keyframe index could not be read falls back to an even grid
    // ffmpeg does not cut on. Nothing can be aligned to that, so there is no
    // master and no variant to move to.
    cutGrid: "even"
  });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });

  await produceSegments(session, 2_000_000);
  drainingReports(manager.viewers.of(session, "viewer"), 1.0);

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.equal(manager.viewers.get("viewer").qualityAsk, null, "asking a player with no variants to change variant is nothing");
  assert.equal(qualityStateOf(session).saidNoVariants, true, "and the reason is stated once, not once per window");
});

test("a height this machine has been MEASURED failing at is not what the way back up offers", async (t) => {
  const { manager, session, dirPath } = await managerWithSession({
    softwarePresetBenchmark: [{ preset: "ultrafast", pixelsPerSec: 1e6 }]
  });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });

  // The base ran 720p at half realtime and the viewer was stepped down to 480p.
  // The base's own height used to be exempt from every refusal — it was the
  // rung on screen, back when a step changed the encode inside it — so the way
  // back up would have asked for 720p again, failed again, and stepped down
  // again, about every hundred seconds for the length of the film.
  qualityStateOf(session).lastAloneSpeed = 0.5;
  session.variantHeight = 720;

  const offered = manager.quality.offeredHeights(session);

  assert.ok(!offered.includes(720) || manager.outputs.variantHeightOf(session) === 720);
  // Now on the 480p variant: 720p has a reading of its own and must be gone.
  session.variantHeight = 480;
  session.encodeHeight = 480;
  session.encodeWidth = 854;
  assert.ok(
    !manager.quality.offeredHeights(session).includes(720),
    "a rung measured below realtime is withdrawn once the viewer has left it"
  );
});

test("a request is answered when the viewers watching are on that height, whoever they are", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });
  // A named viewer followed the request to a 480p step. The step is an output
  // of its own; the picture's own height is still 720.
  const stepId = "aaaaaaaabbbbdddd";
  const step = { ...fakeSession({ dirPath }), id: stepId, isStep: true, variantHeight: 480 };
  step.outputKey = `${session.outputKey}:step480`;
  manager.outputs.set(stepId, step);
  manager.outputs.markStep(step);
  manager.viewers.of(session, "alice").qualityMode = "auto";
  manager.viewers.of(session, "alice").activeVariantId = stepId;

  manager.viewers.get("alice").qualityAsk = { height: 480, at: Date.now(), reason: "measured" };
  const answered = await manager.viewerRequests.getSessionProgress(BASE_ID, "alice");

  assert.equal(answered.requestedHeight, 0, "the viewer is on the height asked for");
  assert.equal(manager.viewers.get("alice").qualityAsk, null, "so the request is let go of");
});

test("a thin link whose buffer is filling moves nothing: the trend, not the reading, decides", async (t) => {
  const { manager, session, dirPath } = await managerWithSession({ transcodeVideo: false });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });
  await produceSegments(session, 2_000_000);
  fillingReports(manager.viewers.of(session, "viewer"), 1.0);

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.equal(manager.viewers.get("viewer").qualityAsk, null);
});

test("a step up being prepared is dropped once the viewer's buffer starts running dry", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });
  session.variantHeight = 480;
  await produceSegments(session, 200_000);
  const viewer = manager.viewers.get("viewer");
  viewer.askQuality(540, "room to spare", Date.now());
  drainingReports(viewer, 80);

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.equal(viewer.qualityAsk, null, "the conditions it was asked under have gone back");
});

test("a picture seen larger than the rung on screen is asked one rung up, when there is room", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });
  session.variantHeight = 480;
  session.encodeWidth = 854;
  session.encodeHeight = 480;
  measureSpeed([...session.runs][0], 2.4);
  // What another output takes to be ready here, computed as the proxy computes
  // it: this mode's speed as the encoding layer has learned it, and the wait
  // for a first output this host was measured to need — the picture's first
  // segment on the addon host, field 2026-08-31.
  qualityStateOf(session).lastAloneSpeed = 2.4;
  manager.encodeOrchestrator.noteStartupCosts({ firstByteWaitSec: 8.4, killCostSec: 0 });
  manager.viewers.get("viewer").noteVisiblePicture({ width: 1920, height: 1080 });
  fillingReports(manager.viewers.get("viewer"), null);

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.equal(manager.viewers.get("viewer").qualityAsk?.height, 540);
  assert.equal(manager.viewers.get("viewer").qualityAsk?.urgent, false, "a step up waits for the cushion");
});

test("a picture seen smaller than the rung on screen moves nothing until a rung of its height is ready", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });
  manager.viewers.get("viewer").noteVisiblePicture({ width: 640, height: 360 });

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.equal(manager.viewers.get("viewer").qualityAsk, null, "no 360p rung is made yet; nothing is started for this alone");
});

test("a COPY taller than the picture seen is left alone", async (t) => {
  const { manager, session, dirPath } = await managerWithSession({ transcodeVideo: false });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });
  manager.viewers.get("viewer").noteVisiblePicture({ width: 640, height: 360 });
  // Every smaller rung is ready for them: what stops the move is the rule
  // about copies, and nothing else.
  manager.renditions.heightReadyFor = () => true;

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.equal(manager.viewers.get("viewer").qualityAsk, null, "a copy is never re-encoded for being taller than the screen");
});

test("a step down for the machine goes to the rung the picture seen bounds, where that is lower", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    // The store closes its watch on the directory as it drops the output, and
    // on Windows the directory stays held until the event loop has turned.
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });
  manager.viewers.get("viewer").noteVisiblePicture({ width: 640, height: 360 });
  measureSpeed([...session.runs][0], 0.7);
  drainingReports(manager.viewers.get("viewer"), 80);

  await manager.quality.noteViewerReported(session.id, "viewer");

  const asked = manager.viewers.get("viewer").qualityAsk?.height;
  assert.ok(asked, "the machine cannot keep up: a step down is asked");
  assert.ok(asked <= 360, `not a rung between that the screen cannot show (asked for ${asked}p)`);
});

test("a machine below realtime whose viewer's buffer is filling moves nothing", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await new Promise((resolve) => setImmediate(resolve));
    await rm(dirPath, { recursive: true, force: true });
  });
  // What the cushion already holds covers the shortfall: no chosen window of
  // slowness decides, the viewer's own buffer trend does.
  measureSpeed([...session.runs][0], 0.7);
  fillingReports(manager.viewers.get("viewer"), 80);

  await manager.quality.noteViewerReported(session.id, "viewer");

  assert.ok(!(manager.viewers.get("viewer").qualityAsk?.height < 720), "no step down while the buffer grows");
});
