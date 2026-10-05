/**
 * @file The rate a copied soundtrack puts on a viewer's link is the rate the
 * file states for THAT track — roadmap item 97, step 11.
 *
 * Not the first rate the banner prints and not the file's total: two tracks of
 * one film can differ fivefold (a stereo AAC and a 5.1 AC3), and the viewer
 * receives only the one they chose. Parsed text, no process.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseStreamCodecs } from "../../services/media/playback-planner.js";
import { buildAudioInventory } from "../../services/media/audio-inventory.js";

const BANNER = [
  "Input #0, matroska,webm, from 'http://127.0.0.1/stream':",
  "  Duration: 01:30:00.00, start: 0.000000, bitrate: 9000 kb/s",
  "  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 24 fps (default)",
  "  Stream #0:1(eng): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s (default)",
  "  Stream #0:2(rus): Audio: ac3, 48000 Hz, 5.1(side), fltp",
  "    Metadata:",
  "      title           : Dub",
  "      BPS             : 640000",
  "  Stream #0:3(fre): Audio: ac3, 48000 Hz, 5.1(side), fltp",
  "At least one output file must be specified"
].join("\n");

test("each soundtrack carries its own stated rate, from its own line or its own statistics tag", () => {
  const { audioTracks } = parseStreamCodecs(BANNER);

  assert.deepEqual(audioTracks.map((track) => track.bitrateKbps), [128, 640, null]);
  assert.notEqual(audioTracks[1].bitrateKbps, 9000, "never the file's total");
});

test("the inventory keeps each track's rate, so the chosen one can be priced", () => {
  const { audioTracks } = parseStreamCodecs(BANNER);
  const inventory = buildAudioInventory({ embedded: audioTracks, videoFileIndex: 0, sidecars: [] });

  assert.deepEqual(inventory.map((entry) => entry.bitrateKbps), [128, 640, null]);
});
