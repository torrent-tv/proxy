import test from "node:test";
import assert from "node:assert/strict";
import { SegmentSourceRanges } from "../../services/media/SegmentSourceRanges.js";

// Fake orchestrator and container only; no torrent.
// torrent-tv/meta#272: one resolver of a segment's source byte ranges.

const METHODS = new Set(["direct-source-index", "container-source-ranges", "packet-index",
  "source-range-cache", "container-index-fallback"]);
const interval = { from: 0, to: 4 };
const video = { type: "video", trackNumber: 1, declaredIndex: 0 };
const audio = { type: "audio", trackNumber: 2, declaredIndex: 0 };

function setup({ answers = {}, container = {}, inspect } = {}) {
  const trackList = [video, audio];
  const packetIndex = { inputFor: ({ trackId, from, to }) => ({ kind: "result", ranges: [[from * 100 + trackId, to * 100 + trackId]] }) };
  const fullContainer = {
    supportsOriginalSourceRanges: async () => false,
    readSourceRanges: async i => ({ kind: "result", ranges: [[i.from * 10, i.to * 10]] }),
    packetTableWouldWait: () => false,
    readPacketIndex: async () => packetIndex,
    ...container,
  };
  const all = {
    tracks: { kind: "result", value: trackList },
    "media-info": { kind: "result", value: { startTimeSeconds: 1.5 } },
    "source-navigation": { kind: "result", value: false },
    packets: { kind: "result", value: packetIndex },
    "source-ranges": { kind: "result", value: { kind: "result", ranges: [[5, 9]], from: 0, to: 4 } },
    ...answers,
  };
  const asked = [];
  const orchestrator = {
    known: () => fullContainer,
    inspect: inspect ?? (async (params, statement) => { asked.push(statement); return all[statement]; }),
  };
  return { resolver: new SegmentSourceRanges({ orchestrator }), asked, trackList, container: fullContainer, packetIndex, all };
}

const params = { sourceKey: "src", fileIndex: 0 };
const modes = new Map([[video, "transcode"], [audio, "transcode"]]);
const base = (over = {}) => ({ rangesKey: "src:0:k", direct: null, interval, tracks: [audio], modes,
  intervalParams: async () => params, isCurrent: () => true, whenBuilt: () => {}, ...over });

test("keyOf joins source, file and the JSON interval", () => {
  const { resolver } = setup();
  assert.equal(resolver.keyOf("src", 3, { from: 1, to: 2 }), 'src:3:{"from":1,"to":2}');
});

test("cache: hit returns the very array, miss returns null", async () => {
  const { resolver } = setup();
  assert.equal(resolver.cached("src:0:k"), null);
  const result = await resolver.resolve(base());
  const hit = resolver.cached("src:0:k");
  assert.equal(hit.kind, "result");
  assert.equal(hit.method, "source-range-cache");
  assert.equal(hit.ranges, result.ranges);
});

test("forget deletes only the keys of that source", async () => {
  const { resolver } = setup();
  await resolver.resolve(base({ rangesKey: "src:0:a" }));
  await resolver.resolve(base({ rangesKey: "srcB:0:a" }));
  resolver.forget("src");
  assert.equal(resolver.cached("src:0:a"), null);
  assert.ok(resolver.cached("srcB:0:a"));
});

test("tracksOf returns the answer's own array and the container read after the await", async () => {
  const { resolver, trackList, container } = setup();
  const a = await resolver.tracksOf(params);
  const b = await resolver.tracksOf(params);
  assert.equal(a.kind, "result");
  assert.equal(a.trackList, trackList);
  assert.equal(b.trackList, trackList);
  assert.equal(a.container, container);
});

test("tracksOf: a container that names no bytes needs an index", async () => {
  const { resolver } = setup({ container: { readSourceRanges: undefined, readPacketIndex: undefined } });
  assert.deepEqual(await resolver.tracksOf(params), { kind: "needs-index", reason: "packet-index-not-yet-available" });
});

test("each file-level step is stale when replaced during the read", async () => {
  const { resolver } = setup();
  assert.deepEqual(await resolver.tracksOf(params, () => false), { kind: "stale" });
  assert.deepEqual(await resolver.shiftOf(params, () => false), { kind: "stale" });
  assert.deepEqual(await resolver.navigable(params, () => false), { kind: "stale" });
});

test("each file-level step makes one inspect of its own statement", async () => {
  const { resolver, asked } = setup();
  await resolver.tracksOf(params); await resolver.shiftOf(params); await resolver.navigable(params);
  assert.deepEqual(asked, ["tracks", "media-info", "source-navigation"]);
});

test("a non-result answer passes through as the same object", async () => {
  const needs = { kind: "needs-ranges", ranges: [[0, 99]] };
  const { resolver } = setup({ answers: { tracks: needs, "media-info": needs, "source-navigation": needs } });
  assert.equal(await resolver.tracksOf(params), needs);
  assert.equal(await resolver.shiftOf(params), needs);
  assert.equal(await resolver.navigable(params), needs);
});

test("shiftOf: no start time is 0, a start time is kept", async () => {
  assert.equal((await setup({ answers: { "media-info": { kind: "result", value: {} } } }).resolver.shiftOf(params)).shift, 0);
  assert.equal((await setup().resolver.shiftOf(params)).shift, 1.5);
});

test("navigable is strictly true", async () => {
  const { resolver } = setup({ answers: { "source-navigation": { kind: "result", value: "yes" } } });
  assert.deepEqual(await resolver.navigable(params), { kind: "result", value: false });
  assert.deepEqual(await setup({ answers: { "source-navigation": { kind: "result", value: true } } }).resolver.navigable(params),
    { kind: "result", value: true });
});

test("readInput: original inspects only source-ranges", async () => {
  const { resolver, asked, all } = setup();
  const read = await resolver.readInput(params, { original: true, tracks: [audio], modes, interval });
  assert.deepEqual(asked, ["source-ranges"]);
  assert.equal(read.method, "container-source-ranges");
  assert.equal(read.input, all["source-ranges"].value);
});

test("readInput: otherwise inspects only packets and takes the wanted tracks' ranges", async () => {
  const { resolver, asked } = setup();
  const read = await resolver.readInput(params, { original: false, tracks: [audio], modes, interval });
  assert.deepEqual(asked, ["packets"]);
  assert.equal(read.method, "packet-index");
  assert.deepEqual(read.input.ranges, [[2, 402]]);
});

test("readInput: memory refused and stale", async () => {
  const answer = { kind: "needs-memory", bytes: 1e9 };
  const { resolver } = setup({ answers: { packets: answer } });
  assert.deepEqual(await resolver.readInput(params, { original: false, tracks: [audio], modes, interval }),
    { kind: "needs-memory", step: "packets", answer });
  assert.deepEqual(await resolver.readInput(params, { original: false, tracks: [audio], modes, interval }, () => false),
    { kind: "stale", step: "packets" });
});

test("readInput: a non-result input is reported at step input", async () => {
  const input = { kind: "terminal", reason: "nope" };
  const { resolver } = setup({ answers: { "source-ranges": { kind: "result", value: input } } });
  assert.deepEqual(await resolver.readInput(params, { original: true, tracks: [audio], modes, interval }),
    { kind: "terminal", step: "input", answer: input });
});

test("resolve: direct index answers and the fallback is not reached", async () => {
  const { resolver, asked } = setup({ container: { supportsOriginalSourceRanges: async () => true } });
  let asks = 0;
  const result = await resolver.resolve(base({ direct: setup({ container: { supportsOriginalSourceRanges: async () => true } }).container,
    intervalParams: async () => { asks += 1; return params; } }));
  assert.equal(result.kind, "result");
  assert.equal(result.method, "direct-source-index");
  assert.deepEqual(result.ranges, [[0, 40]]);
  assert.equal(asks, 0);
  assert.deepEqual(asked, []);
  assert.equal(resolver.cached("src:0:k").ranges, result.ranges);
});

test("resolve: direct index still building is pending and whenBuilt gets the promise", async () => {
  const { container } = setup({ container: { packetTableWouldWait: () => true } });
  const { resolver } = setup();
  const built = [];
  const result = await resolver.resolve(base({ direct: container, whenBuilt: p => built.push(p) }));
  assert.deepEqual(result, { kind: "pending", method: "direct-source-index", step: "direct" });
  assert.equal(built.length, 1);
  assert.ok(built[0] instanceof Promise);
});

test("resolve: no staleness check after the direct read", async () => {
  const { container } = setup({ container: { supportsOriginalSourceRanges: async () => true } });
  const { resolver } = setup();
  const result = await resolver.resolve(base({ direct: container, isCurrent: () => false }));
  assert.equal(result.method, "direct-source-index");
});

test("resolve: a direct throw falls back to source ranges when navigable", async () => {
  const { container } = setup({ container: { supportsOriginalSourceRanges: async () => { throw new Error("x"); } } });
  const { resolver, asked } = setup({ answers: { "source-navigation": { kind: "result", value: true } } });
  const result = await resolver.resolve(base({ direct: container }));
  assert.equal(result.method, "container-source-ranges");
  assert.deepEqual(result.ranges, [[5, 9]]);
  assert.deepEqual(asked, ["source-navigation", "source-ranges"]);
});

test("resolve: no direct and not navigable falls back to packets", async () => {
  const { resolver, asked } = setup();
  const result = await resolver.resolve(base());
  assert.equal(result.method, "packet-index");
  assert.deepEqual(result.ranges, [[2, 402]]);
  assert.deepEqual(asked, ["source-navigation", "packets"]);
  assert.equal(resolver.cached("src:0:k").ranges, result.ranges);
});

test("resolve: navigation needs memory", async () => {
  const answer = { kind: "needs-memory", bytes: 5 };
  const { resolver } = setup({ answers: { "source-navigation": answer } });
  assert.deepEqual(await resolver.resolve(base()),
    { kind: "needs-memory", method: "container-index-fallback", step: "navigation", answer });
});

test("resolve: packets need memory", async () => {
  const answer = { kind: "needs-memory", bytes: 5 };
  const { resolver } = setup({ answers: { packets: answer } });
  assert.deepEqual(await resolver.resolve(base()),
    { kind: "needs-memory", method: "container-index-fallback", step: "packets", answer });
});

test("resolve: no params means the file is gone; stale wins over missing", async () => {
  const { resolver } = setup();
  assert.deepEqual(await resolver.resolve(base({ intervalParams: async () => null })),
    { kind: "needs-source", method: "container-index-fallback", step: "params" });
  assert.deepEqual(await resolver.resolve(base({ intervalParams: async () => null, isCurrent: () => false })),
    { kind: "stale", method: "container-index-fallback", step: "params" });
});

test("resolve: an orchestrator error propagates", async () => {
  const boom = new Error("boom");
  const { resolver } = setup({ inspect: async () => { throw boom; } });
  await assert.rejects(resolver.resolve(base()), boom);
});

test("every method returned is one of the five names", async () => {
  const methods = new Set();
  const direct = setup({ container: { supportsOriginalSourceRanges: async () => true } }).container;
  const waiting = setup({ container: { packetTableWouldWait: () => true } }).container;
  const runs = [
    setup().resolver.resolve(base({ direct })),
    setup().resolver.resolve(base({ direct: waiting })),
    setup().resolver.resolve(base()),
    setup({ answers: { "source-navigation": { kind: "result", value: true } } }).resolver.resolve(base()),
    setup({ answers: { packets: { kind: "needs-memory" } } }).resolver.resolve(base()),
    (async () => { const s = setup(); await s.resolver.resolve(base()); return s.resolver.cached("src:0:k"); })(),
  ];
  for (const r of await Promise.all(runs)) methods.add(r.method);
  for (const method of methods) assert.ok(METHODS.has(method), method);
  assert.ok(methods.has("source-range-cache") && methods.has("direct-source-index"));
});
