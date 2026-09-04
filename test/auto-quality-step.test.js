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
 * A change of resolution is a change of VARIANT. So the proxy ASKS, the request
 * travels in every progress report, and the browser — where the viewer's own
 * choice lives — decides whether to follow it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { Output } from "../services/output/Output.js";
import { viewerOf } from "../services/viewer/Viewer.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";
import { softwareDescriptor, maxrateKbpsFor, nominalKbpsForHeight } from "../services/hwaccel.js";
import { readVideoSampleSize } from "../services/segment-formats/mp4-boxes.js";

const BASE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SEGMENT_SECONDS = 4;

/** A child process that is alive as far as the budget is concerned. */
function fakeEncoder() {
  return {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    kill() {},
    once(event, handler) {
      if (event === "exit") {
        handler();
      }
    }
  };
}

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
      totalDurationSeconds: 400,
      cutGrid
    }),
    state: "ready",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }).learn({ width: 1920, height: 1080, durationSeconds: 400 }),
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    ffmpeg: fakeEncoder(),
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
    encodeStartIndex: 0,
    budgetSlowSince: 0,
    budgetUpSince: 0,
    budgetLastActionAt: 0,
    qualityAsk: null,
    initSizeSaid: "",
    recentSpeed: null,
    rateCapKbps: null,
    viewers: new Map(),
    linkSlowSince: 0,
    lastAloneSpeed: null,
    usesExplicitCuts: false,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentCount: 100,
    progress: { state: "running", processedSeconds: 40, startPositionSeconds: 0, speed: "1.0x" }
  };
}

/**
 * @param {{ transcodeVideo?: boolean, cutGrid?: string }} [options]
 * @returns {Promise<{ manager: HlsSessionManager, session: object, dirPath: string, restarts: number[] }>}
 */
async function managerWithSession({ transcodeVideo = true, cutGrid } = {}) {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "auto-quality-"));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  // A software host: the budget's own precondition.
  manager.videoEncoder = { kind: "software", name: "libx264", inputArgs: [] };
  // A fully-downloaded file, so nothing here is ever read as download-bound —
  // the distinction is tested elsewhere and would only obscure these.
  manager.getSourceStats = async () => ({
    downloadSpeed: 10e6,
    fileProgress: 1,
    fileLength: 4e9
  });
  const session = fakeSession({ dirPath, transcodeVideo, cutGrid });
  manager.sessionsById.set(BASE_ID, session);
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
async function produceSegments(session, bytesEach) {
  // Where a run really writes: the manager reads produced files out of the
  // `run-N` directories, not out of the session directory itself.
  const runDir = path.join(session.dirPath, `run-${session.runSerial}`);
  await mkdir(runDir, { recursive: true });
  session.runDirPath = runDir;
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
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const sizeBefore = `${session.encodeWidth}x${session.encodeHeight}`;
  // Sustained sub-realtime, read as a slope: the run has been slow since well
  // before the window, and the reading is from this very run.
  session.budgetSlowSince = Date.now() - 60_000;
  session.recentSpeed = { speed: 0.7, at: Date.now(), runSerial: session.runSerial };

  await manager.runQualityBudgetOnce();

  assert.equal(
    `${session.encodeWidth}x${session.encodeHeight}`,
    sizeBefore,
    "the size the init segment describes must survive the step — that is the whole fault"
  );
  assert.ok(session.qualityAsk, "the step is a request to the player to move variant");
  assert.ok(
    session.qualityAsk.height < 720,
    `a step DOWN, and 720p was on screen (asked for ${session.qualityAsk?.height}p)`
  );
});

test("the request reaches the browser in the progress report, and stops once the viewer is there", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  session.qualityAsk = { height: 480, at: Date.now(), reason: "measured" };
  const asked = await manager.getSessionProgress(BASE_ID);
  assert.equal(asked.requestedHeight, 480, "the request travels with every progress report");

  // The player moved: the variant it is now watching IS the height asked for.
  session.variantHeight = 480;
  const answered = await manager.getSessionProgress(BASE_ID);
  assert.equal(answered.requestedHeight, 0, "a request the viewer has answered is not repeated");
  assert.equal(session.qualityAsk, null, "and it is let go of, not merely hidden");
});

test("a request the player never follows runs out instead of being repeated for the whole film", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  // A viewer on a manual pick ignores every request by design, and so does a
  // stream with no variants. Neither is an error; both look the same from here.
  session.qualityAsk = { height: 480, at: Date.now() - 120_000, reason: "measured" };

  const progress = await manager.getSessionProgress(BASE_ID);

  assert.equal(progress.requestedHeight, 0);
  assert.equal(session.qualityAsk, null, "said once and let go");
});

test("a COPIED picture is never asked to slow its encoder, because it has none", async (t) => {
  const { manager, session, dirPath } = await managerWithSession({ transcodeVideo: false });
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  // Whatever this reading says, a copy has no encoder to make cheaper: moving
  // the viewer to a RE-ENCODED rung costs the machine more, not less.
  session.budgetSlowSince = Date.now() - 60_000;
  session.recentSpeed = { speed: 0.4, at: Date.now(), runSerial: session.runSerial };

  await manager.runQualityBudgetOnce();

  assert.equal(session.qualityAsk, null, "the copy path's lever is the viewer's link, not the CPU");
});

test("a measured link becomes the encoder's own bitrate ceiling, and nothing else moves", () => {
  // The one lever that reduces what is sent without touching the picture:
  // -maxrate/-bufsize and CRF do not appear in the SPS, so the init segment
  // already in the player's hands goes on describing every fragment.
  const uncapped = softwareDescriptor().buildVideoArgs({
    targetWidth: 1280,
    targetHeight: 720,
    segmentDurationSec: 4,
    fps: 24
  });
  const capped = softwareDescriptor().buildVideoArgs({
    targetWidth: 1280,
    targetHeight: 720,
    segmentDurationSec: 4,
    fps: 24,
    nominalKbps: 1200
  });

  assert.equal(
    uncapped[uncapped.indexOf("-maxrate") + 1],
    `${maxrateKbpsFor(nominalKbpsForHeight(720))}k`,
    "with nothing measured the rung's own nominal rate stands"
  );
  assert.equal(capped[capped.indexOf("-maxrate") + 1], `${maxrateKbpsFor(1200)}k`);
  // Everything that decides the SIZE must be identical in the two.
  assert.deepEqual(
    uncapped.slice(0, uncapped.indexOf("-maxrate")),
    capped.slice(0, capped.indexOf("-maxrate")),
    "the scale filter, the codec and the preset are untouched by a rate cap"
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
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  // Four seconds of segment at 2 MB is ~4 Mbit/s of stream. The viewer reports
  // a link that cannot carry it and a buffer that is running dry.
  await produceSegments(session, 2_000_000);
  viewerOf(session, "viewer").netReport = { linkMbps: 1.0, bufferedAheadSec: 1.5, positionSeconds: null, at: Date.now() };
  session.linkSlowSince = Date.now() - 60_000;

  await manager.runQualityBudgetOnce();

  assert.ok(
    session.qualityAsk,
    "a copy has no encoder to bound, so the only way to send fewer bits is another rendering of the film"
  );
  assert.ok(session.qualityAsk.height < 1080, `a step down (asked for ${session.qualityAsk?.height}p)`);
});

test("with two viewers the budget acts on the WORST link, not on whoever reported last", async (t) => {
  const { manager, session, dirPath } = await managerWithSession({ transcodeVideo: false });
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  await produceSegments(session, 2_000_000);
  // One viewer is comfortable and reported LAST, which under a single field was
  // the whole of what the budget saw. The other cannot carry the stream and is
  // running dry.
  viewerOf(session, "thin").netReport = {
    linkMbps: 1.0,
    bufferedAheadSec: 1.5,
    positionSeconds: 40,
    at: Date.now() - 1_000
  };
  viewerOf(session, "fat").netReport = {
    linkMbps: 80,
    bufferedAheadSec: 60,
    positionSeconds: 40,
    at: Date.now()
  };
  session.linkSlowSince = Date.now() - 60_000;

  await manager.runQualityBudgetOnce();

  assert.ok(
    session.qualityAsk,
    "the viewer who cannot keep up decides, whichever of them reported most recently"
  );
});

test("a report from a viewer who has left stops counting", async (t) => {
  const { manager, session, dirPath } = await managerWithSession({ transcodeVideo: false });
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  await produceSegments(session, 2_000_000);
  // Nothing releases a consumer when a data channel closes (roadmap item 55),
  // so a departed viewer's last reading would otherwise go on deciding for the
  // one still here. It is dropped on the next report rather than kept.
  viewerOf(session, "gone").netReport = {
    linkMbps: 1.0,
    bufferedAheadSec: 1.5,
    positionSeconds: 40,
    at: Date.now() - 120_000
  };
  manager.recordNetReport(session.id, {
    linkMbps: 80,
    bufferedAheadSec: 60,
    consumerId: "here",
    positionSeconds: 40
  });
  session.linkSlowSince = Date.now() - 60_000;

  await manager.runQualityBudgetOnce();

  assert.equal(session.viewers.size, 1, "the stale entry was removed, not merely ignored");
  assert.equal(session.qualityAsk, null, "the viewer who is here can carry the picture");
});

test("the way BACK UP exists, and a bitrate cap is lifted before the picture is enlarged", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  // The viewer is on 480p, the machine has been ahead of realtime for longer
  // than the up window, and nothing is capping the bitrate.
  session.variantHeight = 480;
  session.encodeWidth = 854;
  session.encodeHeight = 480;
  session.recentSpeed = { speed: 2.4, at: Date.now(), runSerial: session.runSerial };
  session.budgetUpSince = Date.now() - 120_000;

  await manager.runQualityBudgetOnce();

  assert.ok(session.qualityAsk, "for most of this project's life there was no step up at all");
  assert.equal(
    session.qualityAsk.height,
    540,
    "one rung at a time: the lowest height above the one on screen, never above the source"
  );
});

test("a capped picture gets its own bitrate back before it is asked to grow", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  session.variantHeight = 480;
  session.encodeWidth = 854;
  session.encodeHeight = 480;
  session.rateCapKbps = 700;
  session.recentSpeed = { speed: 2.4, at: Date.now(), runSerial: session.runSerial };
  session.budgetUpSince = Date.now() - 120_000;
  // A restart is what lifting the cap costs, and spawning ffmpeg is not this
  // test's business — the session is left with no encoder to replace, which is
  // the same path a run that has already ended takes.
  session.ffmpeg = fakeEncoder();

  await manager.runQualityBudgetOnce().catch(() => undefined);

  assert.equal(session.rateCapKbps, null, "the cap goes first: it is cheaper than enlarging the picture");
  assert.equal(
    session.qualityAsk,
    null,
    "and the height is left for a second unbroken window, so the two do not move at once"
  );
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
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  await produceSegments(session, 2_000_000);
  viewerOf(session, "viewer").netReport = { linkMbps: 1.0, bufferedAheadSec: 1.5, positionSeconds: null, at: Date.now() };
  session.linkSlowSince = Date.now() - 60_000;

  await manager.runQualityBudgetOnce();

  assert.equal(session.qualityAsk, null, "asking a player with no variants to change variant is nothing");
  assert.equal(session.saidNoVariants, true, "and the reason is stated once, not once per window");
});

test("a height this machine has been MEASURED failing at is not what the way back up offers", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  // The base ran 720p at half realtime and the viewer was stepped down to 480p.
  // The base's own height used to be exempt from every refusal — it was the
  // rung on screen, back when a step changed the encode inside it — so the way
  // back up would have asked for 720p again, failed again, and stepped down
  // again, about every hundred seconds for the length of the film.
  manager.softwarePresetBenchmark = [{ preset: "ultrafast", pixelsPerSec: 1e6 }];
  session.lastAloneSpeed = 0.5;
  session.variantHeight = 720;

  const offered = manager.offeredHeights(session);

  assert.ok(!offered.includes(720) || manager.variantHeightOf(session) === 720);
  // Now on the 480p variant: 720p has a reading of its own and must be gone.
  session.variantHeight = 480;
  session.encodeHeight = 480;
  session.encodeWidth = 854;
  assert.ok(
    !manager.offeredHeights(session).includes(720),
    "a rung measured below realtime is withdrawn once the viewer has left it"
  );
});

test("a cap is not lifted because there is no higher rung to compare against", async (t) => {
  const { manager, session, dirPath } = await managerWithSession();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  // At the top offered height, so there is no NEXT rung — and the question of
  // whether to lift the cap is about THIS one. Deciding it on "nothing to step
  // to, so yes" took the cap off a link measured at a fifth of what the picture
  // needs, after which #checkLinkBudget put it straight back: two ffmpeg
  // restarts a minute and a half, on exactly the thin cellular viewer the cap
  // exists for.
  session.variantHeight = 1080;
  session.encodeWidth = 1920;
  session.encodeHeight = 1080;
  session.rateCapKbps = 700;
  session.recentSpeed = { speed: 2.4, at: Date.now(), runSerial: session.runSerial };
  session.budgetUpSince = Date.now() - 120_000;
  viewerOf(session, "viewer").netReport = { linkMbps: 1.0, bufferedAheadSec: 30, positionSeconds: null, at: Date.now() };

  await manager.runQualityBudgetOnce();

  assert.equal(session.rateCapKbps, 700, "the link still cannot carry this picture uncapped");
});
