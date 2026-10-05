import assert from "node:assert/strict";
import test from "node:test";
import { MatroskaContainer } from "../../services/media/container/MatroskaContainer.js";
import { ID, element, trackEntry } from "./helpers/matroska-file.js";

test("Matroska locates its Segment beyond an unavailable large Void without reading a head window", async () => {
  const ebml = element(ID.EBML, Buffer.alloc(0));
  const padding = element(ID.VOID, Buffer.alloc(70000));
  const tracks = element(ID.TRACKS, trackEntry({ number: 1, type: 2, codecId: "A_MPEG/L3" }));
  const bytes = Buffer.concat([ebml, padding, element(ID.SEGMENT, tracks)]);
  const voidStart = ebml.length + padding.length - 70000, voidEnd = ebml.length + padding.length;
  const container = new MatroskaContainer({ fileSize: bytes.length, portionBytes: 188,
    readRange: async (start, end) => {
      assert.ok(end < voidStart || start >= voidEnd, `Unneeded Void bytes were read: ${start}-${end}`);
      return bytes.subarray(start, end + 1);
    } });
  const declared = await container.readTracks();
  assert.equal(declared.length, 1);
  assert.equal(declared[0].codecId, "A_MPEG/L3");
});
