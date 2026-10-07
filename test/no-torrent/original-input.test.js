import test from "node:test";
import assert from "node:assert/strict";
import { admitOriginalInput } from "../../services/encode/OriginalInput.js";
import { handleEncodeInputGet } from "../../routes/encode-input/get.js";
import { buildOriginalCommand } from "../../services/encode/source-command.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";

const sources = [{ sourceKey: "source", fileIndex: 3, timeShiftSeconds: 0, input: {
  original: true, fileLength: 20, ranges: [[0, 3], [10, 13]], selections: [{ track: { type: "audio" }, index: 1 }]
} }];

test("original input retains exact file offsets and releases its allowance once", async () => {
  let released = 0;
  const input = await admitOriginalInput({ sources, reserve: async bytes => {
    assert.equal(bytes, 8);
    return () => released++;
  }, readRanges: async () => [Buffer.from("abcd"), Buffer.from("klmn")] });
  assert.equal(input.read(3, 10, 12).bytes.toString(), "klm");
  assert.equal(input.read(3, 3, 10), null, "a missing gap cannot be served or waited on");
  assert.equal(input.read(4, 0, 1), null);
  input.release();
  input.release();
  assert.equal(input.read(3, 0, 1), null);
  assert.equal(released, 1);
});

test("missing input and an incomplete available-only answer return their reservation", async () => {
  let released = 0;
  const reserve = async () => () => released++;
  assert.equal((await admitOriginalInput({ sources, reserve, readRanges: async () => null })).kind, "needs-bytes");
  await assert.rejects(admitOriginalInput({ sources, reserve, readRanges: async () => [Buffer.from("a")] }), /incomplete/);
  assert.equal(released, 2);
});

function reply() {
  return { status: 200, headers: {}, code(status) { this.status = status; return this; },
    header(name, value) { this.headers[name] = value; return this; }, send(body) { this.body = body; return this; } };
}

test("the local HTTP reader refuses missing bytes and remote callers synchronously", async () => {
  const input = await admitOriginalInput({ sources, reserve: async () => () => {},
    readRanges: async () => [Buffer.from("abcd"), Buffer.from("klmn")] });
  const req = { raw: { socket: { remoteAddress: "127.0.0.1" } }, method: "GET",
    params: { token: "1", fileIndex: "3" }, headers: { range: "bytes=10-12" } };
  const deps = { inputOf: () => input };
  const ok = handleEncodeInputGet(req, reply(), deps);
  assert.equal(ok.status, 206);
  assert.equal(ok.headers["Content-Range"], "bytes 10-12/20");
  assert.equal(ok.body.toString(), "klm");
  req.headers.range = "bytes=10-";
  const partial = handleEncodeInputGet(req, reply(), deps);
  assert.equal(partial.status, 206);
  assert.equal(partial.headers["Content-Range"], "bytes 10-13/20");
  assert.equal(partial.body.toString(), "klmn");
  req.headers.range = "bytes=4-10";
  assert.equal(handleEncodeInputGet(req, reply(), deps).status, 503);
  req.raw.socket.remoteAddress = "192.168.1.2";
  assert.equal(handleEncodeInputGet(req, reply(), deps).status, 403);
  input.release();
});

test("original FFmpeg commands retain the audio track and published segment number", () => {
  const command = buildOriginalCommand({ admittedInput: { sources, runTag: "121r1" },
    timeline: { published: Array.from({ length: 123 }, (_, index) => index === 122 ? 860.027 : index * 850.017 / 121),
      cutGrid: "keyframe", sourceStartOf: () => 850.017 },
    startIndex: 121, inputToken: 1, baseUrl: "http://127.0.0.1:9090", audioOnly: true,
    audioSeparate: false, transcodeAudio: true, transcodeVideo: false,
    output: {}, videoEncoder: {}, segmentFormat: fmp4Format, segmentDurationSec: 10 });
  assert.ok(command.args.includes("http://127.0.0.1:9090/encode-input/1/3"));
  assert.ok(command.args.includes("0:a:1?"));
  assert.equal(command.args[command.args.indexOf("-segment_start_number") + 1], "121");
  assert.equal(command.args[command.args.indexOf("-to") + 1], "860.027");
  assert.equal(command.args.includes("pipe:0"), false);
});
