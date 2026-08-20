import assert from "node:assert/strict";
import test from "node:test";
import { mergeContainerSubtitleFlags, pairingHolds } from "../services/subtitle-defaults.js";

test("a flag the container wrote is carried through, and one it did not is not", () => {
  const banner = [
    { index: 0, language: "rus", title: "Forced", isDefault: true },
    { index: 1, language: "eng", title: "SDH", isDefault: true }
  ];
  const declared = [
    { language: "rus", name: "Forced", isDefault: true, declaresDefault: true },
    { language: "eng", name: "SDH", isDefault: true, declaresDefault: false }
  ];
  const merged = mergeContainerSubtitleFlags(banner, declared);
  assert.equal(merged.aligned, true);
  assert.deepEqual(
    merged.tracks.map((track) => [track.isDefault, track.declaresDefault]),
    [[true, true], [true, false]]
  );
});

test("a file that wrote nothing is reported as having written nothing, though ffmpeg marked everything", () => {
  // This is the case the banner cannot express: `FlagDefault` defaults to 1, so
  // ffmpeg prints `(default)` against every track of a file that chose none.
  const banner = [
    { index: 0, language: "rus", title: "", isDefault: true },
    { index: 1, language: "eng", title: "", isDefault: true }
  ];
  const declared = [
    { language: "rus", name: "", isDefault: true, declaresDefault: false },
    { language: "eng", name: "", isDefault: true, declaresDefault: false }
  ];
  const merged = mergeContainerSubtitleFlags(banner, declared);
  assert.equal(merged.aligned, true);
  assert.deepEqual(merged.tracks.map((track) => track.declaresDefault), [false, false]);
});

test("the container's own answer overrides the banner's, in both directions", () => {
  const banner = [
    { index: 0, language: "rus", title: "a", isDefault: true },
    { index: 1, language: "eng", title: "b", isDefault: false }
  ];
  const declared = [
    { language: "rus", name: "a", isDefault: false, declaresDefault: true },
    { language: "eng", name: "b", isDefault: true, declaresDefault: true }
  ];
  const merged = mergeContainerSubtitleFlags(banner, declared);
  assert.deepEqual(merged.tracks.map((track) => track.isDefault), [false, true]);
});

test("a count that differs means the two readings are not the same list", () => {
  // The container declares a picture track the probe did not report; position
  // is then not the correspondence and nothing may be read across.
  const banner = [{ index: 0, language: "rus", title: "", isDefault: true }];
  const declared = [
    { language: "rus", name: "", isDefault: false, declaresDefault: true },
    { language: "eng", name: "", isDefault: true, declaresDefault: true }
  ];
  const merged = mergeContainerSubtitleFlags(banner, declared);
  assert.equal(merged.aligned, false);
  assert.match(merged.reason, /declares 2 subtitle tracks and the probe found 1/);
  assert.deepEqual(merged.tracks.map((track) => [track.isDefault, track.declaresDefault]), [[true, false]]);
});

test("a pair agreeing on neither language nor name refuses the whole alignment", () => {
  const banner = [
    { index: 0, language: "rus", title: "", isDefault: true },
    { index: 1, language: "eng", title: "", isDefault: true }
  ];
  const declared = [
    { language: "eng", name: "", isDefault: true, declaresDefault: true },
    { language: "rus", name: "", isDefault: false, declaresDefault: true }
  ];
  const merged = mergeContainerSubtitleFlags(banner, declared);
  assert.equal(merged.aligned, false);
  assert.deepEqual(merged.tracks.map((track) => track.declaresDefault), [false, false]);
});

test("a container that declares nothing leaves the banner alone", () => {
  const banner = [{ index: 0, language: "rus", title: "", isDefault: true }];
  const merged = mergeContainerSubtitleFlags(banner, []);
  assert.equal(merged.aligned, false);
  assert.equal(merged.tracks[0].isDefault, true);
  assert.equal(merged.tracks[0].declaresDefault, false);
});

test("a name confirms a pairing when the languages are unstated", () => {
  assert.equal(pairingHolds({ language: "und", title: "Forced" }, { language: "", name: "Forced" }), true);
});

test("two tracks that say nothing about themselves do not break the alignment", () => {
  assert.equal(pairingHolds({ language: "und", title: "" }, { language: "", name: "" }), true);
});

test("a stated language that differs is a disagreement", () => {
  assert.equal(pairingHolds({ language: "rus", title: "" }, { language: "eng", name: "" }), false);
});
