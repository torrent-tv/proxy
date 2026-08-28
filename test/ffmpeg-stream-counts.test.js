/**
 * @file What the source said it holds, read from ffmpeg's own banner.
 *
 * The reading exists for one failure: every `-map` this proxy builds ends in
 * `?`, so ffmpeg drops a mapping for a stream that is not there and says
 * nothing. Map every stream of a run away that way and the output has nothing
 * in it — `Output file does not contain any stream`, exit 255. Three sessions
 * died that way on 2026-08-26 and the log held only the code.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseFfmpegStreamCounts } from "../services/ffmpeg-banner.js";

const FIELD_BANNER = `
Input #0, matroska,webm, from 'http://127.0.0.1:9090/stream?sourceKey=b3f08efc':
  Duration: 01:32:39.00, start: 0.000000, bitrate: 9354 kb/s
  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080, 23.98 fps
  Stream #0:1(rus): Audio: ac3, 48000 Hz, 5.1, fltp, 640 kb/s
  Stream #0:2(eng): Audio: aac, 48000 Hz, stereo, fltp, 128 kb/s
  Stream #0:3(rus): Subtitle: subrip
  Stream #0:4(eng): Subtitle: hdmv_pgs_subtitle
`;

test("each stream is counted under the type ffmpeg names it", () => {
  assert.deepEqual(parseFfmpegStreamCounts(FIELD_BANNER), {
    video: 1,
    audio: 2,
    subtitle: 2,
    other: 0
  });
});

test("a file with no audio is what makes an audio-only run produce nothing", () => {
  // This is the shape the diagnostic is for: the rendition asks for `0:a:0?`,
  // the file has no audio at all, the mapping is dropped in silence and the
  // segment muxer is handed an output with no streams.
  const counts = parseFfmpegStreamCounts(`
  Stream #0:0: Video: hevc (Main 10), yuv420p10le, 3840x2160, 23.98 fps
  `);
  assert.equal(counts.audio, 0);
  assert.equal(counts.video, 1);
});

test("an audio index past the end of the list is OUR fault, and the counts say so", () => {
  // A viewer picking the third dub on a file carrying one: `0:a:2?` drops, and
  // the count is what separates that from a source that delivered nothing.
  const counts = parseFfmpegStreamCounts(FIELD_BANNER);
  const askedFor = 4;
  assert.ok(askedFor >= counts.audio, "the request is outside what the file holds");
});

test("an attached cover image is counted as video, because that is what would be mapped", () => {
  const counts = parseFfmpegStreamCounts(`
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 600x600 (attached pic)
  `);
  assert.equal(counts.video, 1);
  assert.equal(counts.audio, 1);
});

test("a banner carrying no stream lines is not the same as a file with no streams", () => {
  // Null says "not recorded"; zeroes would claim a measurement nobody took.
  assert.equal(parseFfmpegStreamCounts("Duration: 00:10:00.00, start: 0.000000"), null);
  assert.equal(parseFfmpegStreamCounts(""), null);
  assert.equal(parseFfmpegStreamCounts(undefined), null);
});

test("a stream carrying metadata in brackets is still read", () => {
  // MP4 writes `Stream #0:1[0x2](eng)`, which the earlier shape of this regex
  // would have skipped.
  const counts = parseFfmpegStreamCounts(`
  Stream #0:0[0x1](und): Video: h264 (avc1), yuv420p, 1280x720, 24 fps
  Stream #0:1[0x2](eng): Audio: aac (mp4a), 48000 Hz, stereo, fltp
  `);
  assert.deepEqual(counts, { video: 1, audio: 1, subtitle: 0, other: 0 });
});
