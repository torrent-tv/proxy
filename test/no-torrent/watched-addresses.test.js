/**
 * @file The admission's prepared and watched addresses (torrent-tv/meta#280,
 * design.md §6.5 A).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { preparedAddresses, watchedAddresses } from "../../services/viewer/watched-addresses.js";

const viewer = (present, activeVariantId = null) => ({ isPresent: () => present, activeVariantId });

function world({ outputs, viewersOf = {}, preparing = [], superseded = () => false }) {
  const byId = new Map(outputs.map(output => [output.id, output]));
  return {
    viewers: {
      outputsBeingPrepared: () => preparing,
      forOutput: output => new Map((viewersOf[output.id] ?? []).map((one, index) => [index, one]))
    },
    outputs: { get: id => byId.get(id), values: () => byId.values(), supersededBy: superseded }
  };
}

test("prepared addresses are the output keys of the outputs being prepared, each once", () => {
  const { viewers, outputs } = world({
    outputs: [{ id: "a", outputKey: "k1" }, { id: "b", outputKey: "k1" }, { id: "c", outputKey: "k2" }, { id: "d" }],
    preparing: ["a", "b", "c", "d", "gone"]
  });
  assert.deepEqual([...preparedAddresses(viewers, outputs)].sort(), ["k1", "k2"]);
});

test("an address shared by a finished and a watched output is watched once", () => {
  const { viewers, outputs } = world({
    outputs: [{ id: "a", outputKey: "k", done: true }, { id: "b", outputKey: "k", done: false }],
    viewersOf: { a: [viewer(true)], b: [viewer(true)] }
  });
  const found = watchedAddresses(viewers, outputs, output => output.done);
  assert.deepEqual([...found], ["k"]);
});

test("a finished output, an absent viewer and a superseded output do not watch", () => {
  const { viewers, outputs } = world({
    outputs: [{ id: "fin", outputKey: "k1", done: true }, { id: "away", outputKey: "k2" }, { id: "old", outputKey: "k3" }],
    viewersOf: { fin: [viewer(true)], away: [viewer(false)], old: [viewer(true, "v2")] },
    superseded: (output, variant) => output.id === "old" && variant === "v2"
  });
  assert.equal(watchedAddresses(viewers, outputs, output => output.done === true).size, 0);
});

test("an output with no address is skipped", () => {
  const { viewers, outputs } = world({ outputs: [{ id: "a" }], viewersOf: { a: [viewer(true)] } });
  assert.equal(watchedAddresses(viewers, outputs, () => false).size, 0);
});
