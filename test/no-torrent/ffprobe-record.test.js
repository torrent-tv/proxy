import test from "node:test";
import assert from "node:assert/strict";
import { ffprobeRecord, ffprobeExtradata } from "../../services/media/container/ffprobe-record.js";

test("compact records preserve escaped separators, control characters and equals", () => {
  assert.deepEqual(ffprobeRecord("stream|index=2|tag:title=A\\|B=C\\nD\\\\E"), {
    kind: "stream", index: "2", "tag:title": "A|B=C\nD\\E" });
  assert.throws(() => ffprobeRecord("packet|size=2|size=3"), /Duplicate/);
  assert.throws(() => ffprobeRecord("packet|size=2\\"), /Truncated/);
  assert.deepEqual(ffprobeRecord("packet|size=2|side_data|"), { kind: "packet", size: "2" });
  assert.throws(() => ffprobeRecord("packet|size=2|side_data|unexpected=3"), /Malformed/);
});

test("extradata uses only hexadecimal columns and verifies complete byte count", () => {
  assert.equal(ffprobeExtradata("\n00000000: 1210 56                                ..V\n", 3).toString("hex"), "121056");
  assert.throws(() => ffprobeExtradata("\n00000000: 1210                                ..\n", 3), /Incomplete/);
  assert.throws(() => ffprobeExtradata("\n00000001: 1210                                ..\n", 2), /address/);
});
