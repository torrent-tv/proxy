import test from "node:test";
import assert from "node:assert/strict";
import { trackFor, selectTracks, readingInterval, segmentReading } from "../../services/media/segment-reading.js";

// Plain track objects only; no torrent.

const off = { type: "video", trackNumber: 1, declaredIndex: 0, isEnabled: false };
const picture = { type: "video", trackNumber: 2, declaredIndex: 1 };
const sound0 = { type: "audio", trackNumber: 3, declaredIndex: 0 };
const sound1 = { type: "audio", trackNumber: 4, declaredIndex: 1 };

test("the picture is the first usable video track", () => {
  const list = [off, picture, sound0, sound1];
  assert.equal(trackFor(list, { type: "video", index: 0, mode: "copy" }), picture);
});

test("the picture's choice index does not matter", () => {
  const list = [off, picture, sound0, sound1];
  assert.equal(trackFor(list, { type: "video", index: null }), trackFor(list, { type: "video", index: 0 }));
});

test("a soundtrack is chosen by its place among soundtracks", () => {
  assert.equal(trackFor([picture, sound0, sound1], { type: "audio", index: 1 }).trackNumber, 4);
});

test("an absent soundtrack gives null", () => {
  assert.equal(trackFor([picture, sound0, sound1], { type: "audio", index: 2 }), null);
});

test("selectTracks gives a mode per track", () => {
  const selection = selectTracks([picture, sound0, sound1], [
    { type: "video", index: 0, mode: "copy" },
    { type: "audio", index: 1, mode: "transcode" }]);
  assert.deepEqual(selection.wanted, [picture, sound1]);
  assert.equal(selection.modes.get(picture), "copy");
  assert.equal(selection.modes.get(sound1), "transcode");
});

test("one absent track makes the whole selection absent", () => {
  assert.equal(selectTracks([picture, sound0], [
    { type: "video", index: 0, mode: "copy" },
    { type: "audio", index: 1, mode: "copy" }]), null);
});

test("trackIds and modes in the interval", () => {
  const result = segmentReading([{ type: "video", trackNumber: 2 }, { type: "audio", trackNumber: 3 }], [
    { type: "video", index: 0, mode: "copy" },
    { type: "audio", index: 0, mode: "transcode" }], { from: 4, to: 8 });
  assert.equal(JSON.stringify(result.interval), '{"from":4,"to":8,"trackIds":[2,3],"modes":{"2":"copy","3":"transcode"}}');
  assert.equal(result.wanted.length, 2);
  assert.equal(result.modes.size, 2);
});

test("the end of the source is kept, before trackIds", () => {
  const selection = selectTracks([picture], [{ type: "video", index: 0, mode: "copy" }]);
  const interval = readingInterval(selection, { from: 8, to: 12, endsWithSource: true });
  assert.equal(interval.endsWithSource, true);
  const keys = Object.keys(interval);
  assert.ok(keys.indexOf("endsWithSource") < keys.indexOf("trackIds"));
  assert.deepEqual(keys, ["from", "to", "endsWithSource", "trackIds", "modes"]);
});

test("the interval does not alter its input", () => {
  const source = { from: 0, to: 4 };
  const selection = selectTracks([picture], [{ type: "video", index: 0, mode: "copy" }]);
  const interval = readingInterval(selection, source);
  assert.notEqual(interval, source);
  assert.equal("trackIds" in source, false);
  assert.equal("modes" in source, false);
});

test("no interval for an absent track", () => {
  assert.equal(segmentReading([picture], [{ type: "audio", index: 0, mode: "copy" }], { from: 0, to: 4 }), null);
});
