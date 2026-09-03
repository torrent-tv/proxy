import assert from "node:assert/strict";
import test from "node:test";
import { AudioOutput, CutGrid, OutputSpec, VideoOutput } from "../services/output/OutputSpec.js";

const TORRENT = "torrent:11f0929918e2b5aa2e5b71ecdbe5c0f1a4bbf7d1";

/**
 * The picture of a file, copied, cut at that file's own keyframes.
 *
 * @param {object} [over]
 * @returns {OutputSpec}
 */
function copiedPicture(over = {}) {
  return new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "keyframe", fileIndex: 0 }),
    video: new VideoOutput({ fileIndex: 0, encode: null }),
    audio: null,
    ...over
  });
}

test("two viewers who chose different soundtracks share one copied picture", () => {
  // The measurement of 2026-09-03: both sessions described the same thing word
  // for word and answered `segment-00000.mp4` with the same 4141899 bytes. The
  // soundtrack they picked is not a property of a picture that carries no
  // sound, so it cannot tell the two apart.
  assert.equal(copiedPicture().toKey(), copiedPicture().toKey());
  assert.equal(copiedPicture().carries, "video-only");
});

test("the viewer's viewport does not fork a picture that is copied", () => {
  // A copy is the source's own size whatever box was asked for, so there is
  // nowhere for a target to appear in the key.
  const key = copiedPicture().toKey();
  assert.ok(!key.includes("x"), `a copied picture states no box: ${key}`);
});

test("two heights of one picture are two outputs", () => {
  const at720 = copiedPicture({
    video: new VideoOutput({ fileIndex: 0, encode: { width: 1280, height: 720, manual: true } })
  });
  const at480 = copiedPicture({
    video: new VideoOutput({ fileIndex: 0, encode: { width: 854, height: 480, manual: true } })
  });
  assert.notEqual(at720.toKey(), at480.toKey());
});

test("a height the viewer forced is not the same output as one the budget may move", () => {
  const forced = copiedPicture({
    video: new VideoOutput({ fileIndex: 0, encode: { width: 1280, height: 720, manual: true } })
  });
  const chosen = copiedPicture({
    video: new VideoOutput({ fileIndex: 0, encode: { width: 1280, height: 720, manual: false } })
  });
  assert.notEqual(forced.toKey(), chosen.toKey());
});

test("a soundtrack is named by the file it lives in and the track inside it", () => {
  // Not by the flat number the browser sends: that number spans the picture's
  // own tracks and the files beside it, so it means different things for
  // different pictures of one torrent.
  const dub = new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "keyframe", fileIndex: 0 }),
    audio: new AudioOutput({ fileIndex: 7, trackIndex: 0, transcode: true })
  });
  assert.equal(dub.carries, "audio-only");
  assert.ok(dub.toKey().includes("a=7/0/aac"), dub.toKey());
});

test("one soundtrack cut for two different pictures is two outputs", () => {
  // The grid of a soundtrack is the picture's, so a rendition made for episode
  // one cannot stand in for one made for episode two even when the dub is the
  // same file.
  const forFirst = new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "keyframe", fileIndex: 0 }),
    audio: new AudioOutput({ fileIndex: 7, trackIndex: 0, transcode: true })
  });
  const forSecond = new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "keyframe", fileIndex: 1 }),
    audio: new AudioOutput({ fileIndex: 7, trackIndex: 0, transcode: true })
  });
  assert.notEqual(forFirst.toKey(), forSecond.toKey());
});

test("a copied soundtrack and a re-encoded one are two outputs", () => {
  const copied = new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "uniform", fileIndex: 0 }),
    audio: new AudioOutput({ fileIndex: 0, trackIndex: 1, transcode: false })
  });
  const encoded = new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "uniform", fileIndex: 0 }),
    audio: new AudioOutput({ fileIndex: 0, trackIndex: 1, transcode: true })
  });
  assert.notEqual(copied.toKey(), encoded.toKey());
});

test("a browser without rendition groups gets an output carrying both tracks", () => {
  const muxed = new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "mpegts",
    grid: new CutGrid({ kind: "keyframe", fileIndex: 0 }),
    video: new VideoOutput({ fileIndex: 0, encode: null }),
    audio: new AudioOutput({ fileIndex: 0, trackIndex: 2, transcode: true })
  });
  assert.equal(muxed.carries, "muxed");
  // And there the soundtrack DOES tell two of them apart, because the output
  // really carries it.
  const other = new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "mpegts",
    grid: new CutGrid({ kind: "keyframe", fileIndex: 0 }),
    video: new VideoOutput({ fileIndex: 0, encode: null }),
    audio: new AudioOutput({ fileIndex: 0, trackIndex: 3, transcode: true })
  });
  assert.notEqual(muxed.toKey(), other.toKey());
});

test("the picture, its soundtrack and the two of them muxed are three outputs", () => {
  const video = copiedPicture();
  const audio = new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "keyframe", fileIndex: 0 }),
    audio: new AudioOutput({ fileIndex: 0, trackIndex: 0, transcode: true })
  });
  const muxed = copiedPicture({
    audio: new AudioOutput({ fileIndex: 0, trackIndex: 0, transcode: true })
  });
  assert.equal(new Set([video.toKey(), audio.toKey(), muxed.toKey()]).size, 3);
});

test("two containers of the same tracks are two outputs", () => {
  assert.notEqual(copiedPicture().toKey(), copiedPicture({ segmentFormatId: "mpegts" }).toKey());
});

test("the same tracks of two different torrents are two outputs", () => {
  assert.notEqual(copiedPicture().toKey(), copiedPicture({ sourceKey: "torrent:0000" }).toKey());
});

test("a picture cut at keyframes and the same picture cut on the even grid are two outputs", () => {
  assert.notEqual(
    copiedPicture().toKey(),
    copiedPicture({ grid: new CutGrid({ kind: "uniform", fileIndex: 0 }) }).toKey()
  );
});
