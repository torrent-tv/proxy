/**
 * @file One numbered list of soundtracks, from two readings of the same file.
 *
 * Two things are being pinned here, and each has cost a real failure elsewhere
 * in this project:
 *
 * 1. **The alignment guard.** The container reading is used ONLY when it can be
 *    lined up with ffmpeg's own numbering, because `0:a:N` is what the encoder
 *    is handed — a flag attributed to the wrong track is worse than a missing
 *    one. Same discipline as `subtitle-defaults.js`, for the same reason.
 * 2. **The flat numbering.** The browser's menu, the `audioTrackIndex` on a
 *    session request and the `a/<n>/` address of a rendition are one number.
 *    Embedded tracks must keep the numbers they have always had, so that a
 *    session created against an older cached plan means the same thing.
 */

import test from "node:test";
import { Container } from "../services/container/Container.js";
import { AudioTrack } from "../services/tracks/AudioTrack.js";
import assert from "node:assert/strict";
import {
  audioRenditionName,
  buildAudioInventory,
  resolveAudioIndex
} from "../services/audio-inventory.js";

test("a pair agreeing on language is accepted", () => {
  assert.equal(Container.pairingHolds({ language: "jpn" }, { language: "jpn" }), true);
});

test("a pair disagreeing on language is refused", () => {
  assert.equal(Container.pairingHolds({ language: "jpn" }, { language: "rus" }), false);
});

test("two tracks that say nothing about themselves do not break the alignment", () => {
  assert.equal(Container.pairingHolds({ language: "und", title: "" }, { language: "", name: "" }), true);
});

test("the container's own flags reach the merged track", () => {
  const merged = Container.mergeAudioFlags(
    [
      { index: 0, language: "eng", title: "", isDefault: true, codec: "aac" },
      { index: 1, language: "eng", title: "Director", isDefault: true, codec: "ac3" }
    ],
    [
      { language: "eng", name: "", isOriginal: true, isDefault: true, declaresDefault: true, channels: 6 },
      { language: "eng", name: "Director", isCommentary: true, isDefault: false, declaresDefault: true, channels: 2 }
    ]
  );
  assert.equal(merged.aligned, true);
  assert.equal(merged.tracks[0].isOriginal, true);
  assert.equal(merged.tracks[0].channels, 6);
  assert.equal(merged.tracks[1].isCommentary, true);
  // Matroska defaults FlagDefault to 1 and ffmpeg prints the applied default, so
  // the banner said both tracks were default. The container says otherwise.
  assert.equal(merged.tracks[1].isDefault, false);
});

test("a count that differs drops the container reading whole", () => {
  const merged = Container.mergeAudioFlags(
    [{ index: 0, language: "eng", isDefault: true }],
    [{ language: "eng" }, { language: "rus" }]
  );
  assert.equal(merged.aligned, false);
  assert.match(merged.reason, /declares 2 audio tracks and the probe found 1/);
  // Nothing of it is used — not even the flags that happened to line up.
  assert.equal(merged.tracks[0].isCommentary, false);
  assert.equal(merged.tracks[0].declaresDefault, false);
});

test("one pair that agrees on neither language nor title drops it too", () => {
  const merged = Container.mergeAudioFlags(
    [{ index: 0, language: "jpn", title: "" }, { index: 1, language: "rus", title: "" }],
    [{ language: "jpn", name: "" }, { language: "eng", name: "" }]
  );
  assert.equal(merged.aligned, false);
  assert.match(merged.reason, /audio 1 is/);
});

test("embedded tracks keep the numbers they have always had, sidecars follow", () => {
  const inventory = buildAudioInventory({
    embedded: [
      { language: "jpn", codec: "aac", isDefault: true },
      { language: "eng", codec: "ac3", title: "Commentary", isCommentary: true }
    ],
    videoFileIndex: 24,
    sidecars: [
      {
        file: { fileIndex: 12, name: "ep.mka", folders: ["Rus Sound"], extension: ".mka" },
        tracks: [{ language: "rus", codecId: "A_AC3", channels: 6 }]
      }
    ]
  });

  assert.deepEqual(inventory.map((entry) => entry.index), [0, 1, 2]);
  assert.deepEqual(inventory.map((entry) => entry.fileIndex), [24, 24, 12]);
  assert.deepEqual(inventory.map((entry) => entry.sourceTrackIndex), [0, 1, 0]);
  assert.deepEqual(inventory.map((entry) => entry.kind), ["embedded", "embedded", "sidecar"]);
  assert.equal(inventory[2].codec, "ac3");
  assert.deepEqual(inventory[2].folders, ["Rus Sound"]);
  assert.equal(inventory[2].fileName, "ep.mka");
});

test("a sidecar whose table could not be read is still offered, as one track", () => {
  const inventory = buildAudioInventory({
    embedded: [{ language: "eng", codec: "aac" }],
    videoFileIndex: 0,
    sidecars: [{ file: { fileIndex: 1, name: "dub.ac3", folders: [], extension: ".ac3" }, tracks: [] }]
  });
  assert.equal(inventory.length, 2);
  assert.equal(inventory[1].sourceTrackIndex, 0);
  // The extension of a bare elementary stream IS its codec.
  assert.equal(inventory[1].codec, "ac3");
});

test("a sidecar carrying two tracks contributes both", () => {
  const inventory = buildAudioInventory({
    embedded: [],
    videoFileIndex: 0,
    sidecars: [
      {
        file: { fileIndex: 3, name: "dubs.mka", folders: [], extension: ".mka" },
        tracks: [{ language: "rus" }, { language: "ukr" }]
      }
    ]
  });
  assert.deepEqual(inventory.map((entry) => [entry.index, entry.sourceTrackIndex]), [[0, 0], [1, 1]]);
});

test("the flat number resolves back to a file and a track inside it", () => {
  const inventory = buildAudioInventory({
    embedded: [{ language: "jpn" }],
    videoFileIndex: 24,
    sidecars: [{ file: { fileIndex: 12, name: "ep.mka", folders: [], extension: ".mka" }, tracks: [{}] }]
  });
  assert.equal(resolveAudioIndex(inventory, 1).fileIndex, 12);
  assert.equal(resolveAudioIndex(inventory, 1).sourceTrackIndex, 0);
  assert.equal(resolveAudioIndex(inventory, 9), null);
});

test("codec identifiers are translated to the names the browser judges by", () => {
  assert.equal(AudioTrack.codecNameOf({ codec: "AAC" }), "aac");
  assert.equal(AudioTrack.codecNameOf({ codecId: "A_AC3" }), "ac3");
  assert.equal(AudioTrack.codecNameOf({ codecId: "A_AAC/MPEG4/LC" }), "aac");
  assert.equal(AudioTrack.codecNameOf({ codecId: "A_PCM/INT/LIT" }), "pcm");
  assert.equal(AudioTrack.codecNameOf({ codecId: "ec-3" }), "eac3");
  assert.equal(AudioTrack.codecNameOf({}, ".dts"), "dts");
  assert.equal(AudioTrack.codecNameOf({}, ".unknown"), "");
});

test("a rendition is named by what the file says, and two never share a name", () => {
  const inventory = buildAudioInventory({
    embedded: [{ language: "jpn" }],
    videoFileIndex: 0,
    sidecars: [
      { file: { fileIndex: 1, name: "a.mka", folders: ["Rus Sound"], extension: ".mka" }, tracks: [{}] },
      { file: { fileIndex: 2, name: "b.mka", folders: ["Rus Sound"], extension: ".mka" }, tracks: [{}] }
    ]
  });
  assert.equal(audioRenditionName(inventory[0], inventory), "jpn");
  // Both sidecars sit in the same folder and neither names itself, so the names
  // would collide — and hls.js groups renditions by name.
  assert.notEqual(
    audioRenditionName(inventory[1], inventory),
    audioRenditionName(inventory[2], inventory)
  );
});

test("a commentary says so in its rendition name", () => {
  const inventory = buildAudioInventory({
    embedded: [{ language: "eng" }, { language: "eng", title: "Director", isCommentary: true }],
    videoFileIndex: 0,
    sidecars: []
  });
  assert.match(audioRenditionName(inventory[1], inventory), /commentary/);
});
