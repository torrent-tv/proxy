import test from "node:test";
import assert from "node:assert/strict";
import { OSHASH_EDGE_BYTES, hasOshash, oshash } from "../../services/media/oshash.js";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";
import { handleApiSourceFingerprintGet } from "../../routes/api/sources/fingerprint/get.js";

const EDGE = OSHASH_EDGE_BYTES;

test("a file of zeros hashes to its size", () => {
  const size = 12_909_756;
  assert.equal(oshash(size, new Uint8Array(EDGE), new Uint8Array(EDGE)), size.toString(16).padStart(16, "0"));
});

test("each edge is read as little-endian 64-bit words and added with the size", () => {
  const head = new Uint8Array(EDGE);
  head[0] = 1;                    // the first word is 1
  const tail = new Uint8Array(EDGE);
  tail[EDGE - 1] = 0x80;          // the last word is 0x8000000000000000
  assert.equal(oshash(2 * EDGE, head, tail), (BigInt(2 * EDGE) + 1n + (1n << 63n)).toString(16).padStart(16, "0"));
});

test("the sum wraps at 64 bits", () => {
  const head = new Uint8Array(EDGE).fill(0xff);
  const tail = new Uint8Array(EDGE);
  const sum = BigInt.asUintN(64, BigInt(2 * EDGE) + BigInt(EDGE / 8) * ((1n << 64n) - 1n));
  assert.equal(oshash(2 * EDGE, head, tail), sum.toString(16).padStart(16, "0"));
});

test("a file shorter than both edges has no hash", () => {
  assert.equal(hasOshash(2 * EDGE - 1), false);
  assert.equal(hasOshash(2 * EDGE), true);
  assert.throws(() => oshash(10, new Uint8Array(EDGE), new Uint8Array(EDGE)), RangeError);
});

/** A file of `size` zero bytes of which only the listed ranges are held. */
function holding(size, held) {
  return { sourceKey: "s", fileIndex: 0, fileSize: size,
    readRange: async (start, end) => (held.some(([a, b]) => start >= a && end <= b) ? Buffer.alloc(end - start + 1) : null) };
}

test("the fingerprint statement answers from the two edges and asks for the missing one", async () => {
  const size = 5 * EDGE;
  const orchestrator = new ContainerOrchestrator();
  const missing = await orchestrator.inspect(holding(size, [[0, EDGE - 1]]), "fingerprint");
  assert.equal(missing.kind, "needs-ranges");
  assert.deepEqual(missing.ranges, [[size - EDGE, size - 1]]);
  const whole = await orchestrator.inspect(holding(size, [[0, EDGE - 1], [size - EDGE, size - 1]]), "fingerprint");
  assert.deepEqual(whole.value, { hash: size.toString(16).padStart(16, "0"), size });
  const short = await orchestrator.inspect(holding(EDGE, [[0, EDGE - 1]]), "fingerprint");
  assert.equal(short.kind, "terminal");
});

test("the route answers 200, 202 and 404 and refuses what it cannot address", async () => {
  const reply = () => { const r = { code(c) { r.status = c; return r; }, send(b) { r.body = b; return r; } }; return r; };
  const deps = result => ({ sourceRegistry: { get: key => (key === "s" ? {} : null) }, inspectFingerprint: async () => result });
  const ask = async (params, result) => { const r = reply(); await handleApiSourceFingerprintGet({ params }, r, deps(result)); return r; };
  const ok = await ask({ sourceKey: "s", fileIndex: "2" }, { kind: "result", value: { hash: "00000000000000ff", size: 255 } });
  assert.deepEqual([ok.status ?? 200, ok.body], [200, { hash: "00000000000000ff", size: 255 }]);
  assert.equal((await ask({ sourceKey: "s", fileIndex: "2" }, { kind: "needs-ranges" })).status, 202);
  assert.equal((await ask({ sourceKey: "s", fileIndex: "2" }, { kind: "terminal", reason: "file-too-short" })).status, 404);
  assert.equal((await ask({ sourceKey: "x", fileIndex: "2" }, { kind: "pending" })).status, 404);
  assert.equal((await ask({ sourceKey: "s", fileIndex: "-1" }, { kind: "pending" })).status, 400);
});
