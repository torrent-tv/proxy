import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { AudioOutput, CutGrid, isOutputName, OutputSpec, VideoOutput } from "../services/output/OutputSpec.js";

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
    video: new VideoOutput({ fileIndex: 0, encode: { width: 1280, height: 720, exactSize: true } })
  });
  const at480 = copiedPicture({
    video: new VideoOutput({ fileIndex: 0, encode: { width: 854, height: 480, exactSize: true } })
  });
  assert.notEqual(at720.toKey(), at480.toKey());
});

test("a height produced exactly is not the same output as one the budget may move", () => {
  const forced = copiedPicture({
    video: new VideoOutput({ fileIndex: 0, encode: { width: 1280, height: 720, exactSize: true } })
  });
  const chosen = copiedPicture({
    video: new VideoOutput({ fileIndex: 0, encode: { width: 1280, height: 720, exactSize: false } })
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
