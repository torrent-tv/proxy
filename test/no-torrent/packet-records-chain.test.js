import test from "node:test";
import assert from "node:assert/strict";
import { PacketRecords } from "../../services/media/container/PacketRecords.js";
import { PacketRecordsChain } from "../../services/media/container/PacketRecordsChain.js";

function recordsFor(times) {
  const records = new PacketRecords();
  for (const pts of times) records.push({ pts, duration: 0.25, ranges: [[0, 0]] });
  return records;
}

test("a packet chain visits time matches with global indices in storage order", () => {
  const first = recordsFor([0, 2, 1]);
  const second = recordsFor([4, 3, 5]);
  const chain = new PacketRecordsChain([first, second]);
  const matches = [];

  chain.forEachInTimeRange(0.5, 4.5, (index, pts) => matches.push({ index, pts }));

  assert.deepEqual(matches, [
    { index: 1, pts: 2 },
    { index: 2, pts: 1 },
    { index: 3, pts: 4 },
    { index: 4, pts: 3 }
  ]);
  assert.equal(chain.someAtTime(3, index => index === 4), true);
  assert.equal(chain.someAtTime(3.5, () => true), false);
});
