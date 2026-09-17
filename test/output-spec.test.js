import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { AudioOutput, CutGrid, isOutputName, OutputSpec, VideoOutput } from "../services/encode/output/OutputSpec.js";

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

function encoded(over = {}) {
  return copiedPicture({
    video: new VideoOutput({
      fileIndex: 0,
      encode: { encoder: "libx264", width: 1280, height: 720, fps: 24, preset: "veryfast", tonemap: false, ...over }
    })
  });
}

test("two heights of one picture are two outputs", () => {
  assert.notEqual(encoded().toKey(), encoded({ width: 854, height: 480 }).toKey());
});

test("an output is the format produced, and every part of it that reaches the header tells two apart", () => {
  const base = encoded().toKey();
  assert.notEqual(base, encoded({ preset: "ultrafast" }).toKey(), "the speed setting changes the PPS");
  assert.notEqual(base, encoded({ encoder: "h264_nvenc" }).toKey(), "another encoder writes another SPS");
  assert.notEqual(base, encoded({ fps: 30 }).toKey(), "the frame rate");
  assert.notEqual(base, encoded({ tonemap: true }).toKey(), "a tone-mapped picture");
});

test("how the format was asked for is not part of it", () => {
  const asked = new VideoOutput({
    fileIndex: 0,
    encode: { encoder: "libx264", width: 1280, height: 720, fps: 24, preset: "veryfast", tonemap: false, exactSize: true }
  });
  assert.equal(copiedPicture({ video: asked }).toKey(), encoded().toKey());
});

test("a key reads back into the output it names", () => {
  const muxed = new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "mpegts",
    grid: new CutGrid({ kind: "uniform", fileIndex: 2 }),
    video: new VideoOutput({
      fileIndex: 2,
      encode: { encoder: "libx264", width: 854, height: 480, fps: 25, preset: null, tonemap: true }
    }),
    audio: new AudioOutput({ fileIndex: 5, trackIndex: 1, transcode: true })
  });
  for (const spec of [copiedPicture(), encoded(), muxed]) {
    assert.equal(OutputSpec.fromKey(spec.toKey())?.toKey(), spec.toKey());
  }
});

test("a key naming the box a viewer asked for does not read back, because it cannot say what format is inside", () => {
  assert.equal(OutputSpec.fromKey(`${TORRENT}:fmt=fmp4:grid=even@0:video-only:v=0/enc:1280x720:exact`), null);
  assert.equal(OutputSpec.fromKey(`${TORRENT}:fmt=fmp4:grid=even@0:video-only:v=0/enc:1280x720:budget`), null);
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

test("an output's name follows from its identity and from nothing else", () => {
  // MANY VIEWERS OF ONE OUTPUT address one name because the name is the
  // output's. Nobody arranges it, and nothing about the request enters it: two
  // people opening the same film at different moments and at different places
  // are handed the same name.
  assert.equal(copiedPicture().toName(), copiedPicture().toName());
  assert.notEqual(
    copiedPicture().toName(),
    copiedPicture({ video: new VideoOutput({ fileIndex: 1, encode: null }) }).toName(),
    "and two different outputs are two different names"
  );
  // Stated against the key itself, which is the one thing that proves nothing
  // ELSE got mixed in. Two specs built in one test run agree even if the name
  // secretly carried the clock, because the clock has not moved between them —
  // and "however far apart they arrive" is the whole property.
  assert.equal(
    copiedPicture().toName(),
    createHash("sha256").update(copiedPicture().toKey()).digest("hex").slice(0, 16)
  );
});

test("a name is safe to carry whole, and the guard that admits it agrees", () => {
  // The name reaches the filesystem: it is what the produced pieces of this
  // output are found under. So the shape is asserted here AND where a request
  // is admitted, and the two must be changed together — they were not, the
  // first time this name was minted, and every guarded route would have refused
  // every request while no check said a word.
  const name = copiedPicture().toName();

  assert.ok(isOutputName(name), "the guard admits what the minting produces");
  assert.equal(encodeURIComponent(name), name, "and it needs no escaping to be carried whole");
  // What the guard is FOR.
  assert.equal(isOutputName("../../etc/passwd"), false);
  assert.equal(isOutputName("aaaaaaaa1111222"), false, "fifteen is not sixteen");
  assert.equal(isOutputName("11111111-2222-3333-4444-555555555555"), false, "and the old shape is gone");
});
