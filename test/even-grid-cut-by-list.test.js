/**
 * @file A re-encode on the even grid is cut by the list, so a stopped run
 * cannot leave a short piece under its served name.
 *
 * The `hls` muxer renames the piece it has open whenever it ends — on our
 * SIGTERM and when its input stops — and that is how a piece shorter than its
 * span became servable. Measured 2026-10-05 with ffmpeg 8.1.2 on the addon
 * host: a 4 s piece stopped 3 s in stayed as `segment-00001.mp4` holding 3.04 s.
 * Field 2026-09-27 shows the cost after a backward seek: piece #111 held 0.37 s
 * of 4.2 s, the browser appended it, counted the fragment as loaded and never
 * asked for that stretch again.
 *
 * Nothing here runs ffmpeg or a torrent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRunCommand } from "../services/encode/run-command.js";
import { computeCutGrid, cutsAtGivenTimes } from "../services/encode/output/cut-grid.js";
import { Timeline } from "../services/encode/output/Timeline.js";
import { PLAYLIST_FILE_NAME } from "../services/encode/output/index.js";
import { fmp4Format } from "../services/encode/segment-formats/fmp4.js";
import { mpegtsFormat } from "../services/encode/segment-formats/mpegts.js";
import { SoftwareEncoder } from "../services/encode/SoftwareEncoder.js";
import { directoryNameFor, SegmentStore } from "../services/storage/segment-store/SegmentStore.js";

const SEGMENT_SECONDS = 4;

/**
 * A re-encode of a 40 s film on the even grid, starting at piece #3.
 *
 * @param {object} segmentFormat
 * @returns {{ args: string[], cutTimes: number[] | null }}
 */
function evenGridRun(segmentFormat) {
  const grid = computeCutGrid({ useKeyframeGrid: false, durationSeconds: 40, segDur: SEGMENT_SECONDS });
  const timeline = new Timeline({ boundaries: grid.boundaries, sourceTimes: grid.sourceTimes, cutGrid: "uniform" });
  return buildRunCommand({
    keyframes: { times: null },
    inputFile: { startTime: 0 },
    audioFile: { startTime: 0 },
    inputUrl: "http://127.0.0.1/stream",
    audioInputUrl: "",
    timeline,
    output: { encodeWidth: 854, encodeHeight: 480, outputFps: 24, softwarePreset: "veryfast", applyTonemap: false },
    segmentFormat,
    transcodeVideo: true,
    transcodeAudio: false,
    audioOnly: false,
    audioSeparate: true,
    audioSourceTrackIndex: 0,
    rateControl: null,
    startIndex: 3,
    endIndex: 9,
    videoEncoder: new SoftwareEncoder(),
    segmentDurationSec: SEGMENT_SECONDS
  });
}

/**
 * @param {string[]} args
 * @param {string} flag
 * @returns {string | undefined}
 */
function valueOf(args, flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

for (const format of [fmp4Format, mpegtsFormat]) {
  test(`a re-encode on the even grid is cut by the segment muxer at the grid's own times (${format.id})`, () => {
    const { args, cutTimes } = evenGridRun(format);
    assert.equal(valueOf(args, "-f"), "segment", "the hls muxer renames the piece it has open when it ends");
    assert.ok(!args.includes("hls"));
    // The interior cuts of #3..#9, measured from the run's own start at 12 s.
    assert.deepEqual(cutTimes, [4, 8, 12, 16, 20, 24]);
    assert.equal(valueOf(args, "-segment_times"), "4,8,12,16,20,24");
    // One list for the cuts and for the keyframes forced at them.
    assert.equal(valueOf(args, "-force_key_frames"), "4,8,12,16,20,24");
    assert.equal(valueOf(args, "-segment_start_number"), "3");
    assert.equal(valueOf(args, "-segment_list"), "pipe:3", "a closed piece is reported, so it can be proven");
    assert.equal(args.at(-1), format.makingFileNameTemplate("3"), "it is written under a working name");
  });
}

test("every output with a grid is cut at given times, and only those", () => {
  const even = new Timeline({ boundaries: [0, 4, 8], cutGrid: "uniform" });
  const keyframe = new Timeline({ boundaries: [0, 3.5, 8], cutGrid: "keyframe" });
  for (const timeline of [even, keyframe]) {
    assert.equal(cutsAtGivenTimes({ segmentFormat: fmp4Format, timeline }), true);
    assert.equal(cutsAtGivenTimes({ segmentFormat: mpegtsFormat, timeline }), true);
  }
  // A film with no duration has no grid to hand over.
  assert.equal(cutsAtGivenTimes({ segmentFormat: fmp4Format, timeline: new Timeline({ boundaries: [], cutGrid: "uniform" }) }), false);
  // A format that cannot take a list.
  assert.equal(cutsAtGivenTimes({ segmentFormat: { explicitTimesMuxerArgs: () => null }, timeline: even }), false);
});

test("pieces the hls muxer named in an earlier life of the process are not adopted", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "even-grid-adopt-"));
  const store = new SegmentStore({ root, logger: { info: () => {}, warn: () => {} } });
  t.after(() => {
    store.dropAll("the check is over");
    rmSync(root, { recursive: true, force: true });
  });
  const key = "torrent:abc:fmt=fmp4:grid=even@0:video-only:v=0/enc/libx264/854x480@24/veryfast/none/vbv=-";
  const dir = path.join(root, directoryNameFor(key));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "key.txt"), `${key}\n`);
  for (let index = 0; index <= 3; index += 1) {
    writeFileSync(path.join(dir, fmp4Format.segmentFileName(index)), Buffer.alloc(16));
  }
  writeFileSync(path.join(dir, fmp4Format.initFileName), Buffer.alloc(16));
  // What the hls muxer leaves: its own list naming what it renamed itself, the
  // last entry being the piece it had open when it was stopped.
  writeFileSync(path.join(dir, PLAYLIST_FILE_NAME), [
    "#EXTM3U",
    "#EXT-X-MAP:URI=\"init.mp4\"",
    "#EXTINF:4.000000,",
    fmp4Format.segmentFileName(2),
    "#EXTINF:1.166667,",
    fmp4Format.segmentFileName(3),
    "#EXT-X-ENDLIST",
    ""
  ].join("\n"));

  const taken = store.adoptWhatSurvived(() => fmp4Format, { selfNamedListFileName: PLAYLIST_FILE_NAME });

  assert.equal(taken.adopted, 1);
  assert.equal(taken.unprovenRemoved, 2);
  assert.deepEqual(store.provenNumbers(key), [0, 1], "pieces we published ourselves are kept");
  assert.ok(!readdirSync(dir).includes(PLAYLIST_FILE_NAME), "the list goes with the pieces it named");
  assert.ok(!readdirSync(dir).includes(fmp4Format.initFileName), "and so does the init file that muxer wrote");
});
