import assert from "node:assert/strict";
import test from "node:test";
import { PacketIndex } from "../../services/media/container/PacketIndex.js";
import { nativeSourceMap } from "../../services/viewer/NativeSourceMap.js";
import { Viewers } from "../../services/viewer/Viewers.js";

function source() {
  const index = new PacketIndex();
  index.declareTrack(1, { type: "video" });
  for (let pts = 0; pts < 100; pts++) index.append(1, { pts, duration: 1, keyframe: true,
    ranges: [[100 + pts * 100, 100 + pts * 100 + (pts % 3 + 1) * 10]] });
  index.complete(1);
  return { index, tracks: [{ type: "video", trackNumber: 1 }], durationSeconds: 100,
    allowanceSeconds: 4, now: 21000, urgentReadyFor: () => true };
}

test("native source demand orders exact packets throughout the film, including future intervals", () => {
  const viewers = new Viewers();
  viewers.selectsFile("watching", "source", 0, 1000, { positionSeconds: 20, wantsToPlay: true });
  const zones = nativeSourceMap({ ...source(), viewers: viewers.forSource("source") });
  assert.ok(zones.some(zone => zone.priority === 100 && zone.byteStart === 2100));
  assert.ok(zones.some(zone => zone.priority > 1 && zone.priority < 100 && zone.byteStart > 2500));
  assert.ok(zones.some(zone => zone.byteEnd === 10010));
  assert.ok(zones.every(zone => zone.byteStart >= 100 && zone.byteEnd <= 10010));
  assert.ok(zones.some(zone => zone.behind && zone.byteStart === 100));
});

test("native pause attenuation is applied before merging and leaves the active viewer urgent", () => {
  const viewers = new Viewers();
  viewers.selectsFile("paused", "source", 0, 1000, { positionSeconds: 20, wantsToPlay: false });
  viewers.selectsFile("watching", "source", 0, 1000, { positionSeconds: 80, wantsToPlay: true });
  const params = { ...source(), viewers: viewers.forSource("source") };
  const pausedPacket = zones => zones.filter(zone => zone.byteStart <= 2100 && zone.byteEnd >= 2110);
  const urgent = nativeSourceMap({ ...params, urgentReadyFor: () => false });
  assert.ok(pausedPacket(urgent).some(zone => zone.priority === 100 && zone.urgent));
  const zones = nativeSourceMap(params);
  assert.ok(pausedPacket(zones).every(zone => zone.priority >= 1 && zone.priority < 100 && !zone.urgent));
  assert.ok(zones.some(zone => zone.byteStart <= 8100 && zone.byteEnd >= 8130 && zone.priority === 100 && zone.urgent));
  viewers.hasGone("watching");
  const sole = nativeSourceMap({ ...params, viewers: viewers.forSource("source") });
  assert.ok(pausedPacket(sole).some(zone => zone.priority === 100 && zone.urgent));
  assert.deepEqual(nativeSourceMap({ ...params, viewers: [] }), []);
});
