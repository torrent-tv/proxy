import test from "node:test";
import assert from "node:assert/strict";
import { MatroskaContainer } from "../services/media/container/MatroskaContainer.js";
import { Mp4Container } from "../services/media/container/Mp4Container.js";
import { ContainerOrchestrator } from "../services/media/ContainerOrchestrator.js";
import { ChapterOrchestrator } from "../services/media/ChapterOrchestrator.js";
import { MediaReadRequests } from "../services/media/MediaReadRequests.js";
import { IndexMemory } from "../services/storage/IndexMemory.js";
import { navigationSections } from "../services/media/container/chapters.js";
import { BytesUnavailable } from "../services/media/container/unavailable.js";
import { handleApiSourceChaptersGet } from "../routes/api/sources/chapters/get.js";
import { ChapterController } from "../services/server/controllers/ChapterController.js";

const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const u16 = (value) => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
function ebml(id, ...parts) {
  const data = Buffer.concat(parts.map((part) => typeof part === "string" ? Buffer.from(part) : part));
  const idBytes = Buffer.from(id.toString(16).padStart(Math.ceil(id.toString(16).length / 2) * 2, "0"), "hex");
  let width = 1;
  while (data.length >= 2 ** (7 * width) - 1) width++;
  const size = Buffer.alloc(width);
  let value = BigInt(data.length) | (1n << BigInt(7 * width));
  for (let at = width - 1; at >= 0; at--) { size[at] = Number(value & 255n); value >>= 8n; }
  return Buffer.concat([idBytes, size, data]);
}
const atom = (uid, start, title, ...more) => ebml(0xb6, ebml(0x73c4, u64(uid)), ebml(0x91, u64(start)),
  ebml(0x80, ebml(0x85, title)), ...more);
const edition = (...atoms) => ebml(0x45b9, ...atoms);
const mkv = (...fields) => Buffer.concat([ebml(0x1a45dfa3), ebml(0x18538067, ...fields)]);
const mpbox = (type, ...parts) => { const data = Buffer.concat(parts); return Buffer.concat([u32(data.length + 8), Buffer.from(type), data]); };
const table = (type, width, entries) => mpbox(type, Buffer.alloc(4), u32(entries.length / width), ...entries.map(u32));
const movie = (duration = 5000) => mpbox("mvhd", Buffer.alloc(12), u32(1000), u32(duration));
const nero = (...items) => mpbox("chpl", Buffer.alloc(4), Buffer.from([items.length]), ...items.map(([time, title]) => {
  const bytes = Buffer.from(title); return Buffer.concat([u64(time), Buffer.from([bytes.length]), bytes]);
}));
const mp4 = (...fields) => Buffer.concat([mpbox("ftyp", Buffer.from("isom"), u32(0)), mpbox("moov", ...fields)]);
function heldFile(bytes, ContainerClass, ranges = [[0, bytes.length - 1]]) {
  let reads = 0;
  const held = { ranges, read: async (start, end) => { reads++; return ranges.some(([a, b]) => start >= a && end <= b) ? bytes.subarray(start, end + 1) : null; } };
  const container = new ContainerClass({ fileSize: bytes.length, readRange: () => { throw new Error("Fetching reader called"); } });
  return { held, container, reads: () => reads };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Matroska chapter times are nanoseconds, UID strings preserve all bits", async () => {
  const bytes = mkv(ebml(0x1549a966, ebml(0x2ad7b1, u64(5000000))), ebml(0x1043a770,
    edition(atom(18446744073709551615n, 90000000000n, "OP"), atom(2, 180000000000n, "Story"))));
  const { held, container } = heldFile(bytes, MatroskaContainer);
  const result = await container.readChapters(held);
  assert.equal(result.state, "available");
  assert.equal(result.sections[0].uid, "18446744073709551615");
  assert.equal(result.sections[0].startSeconds, 90);
  assert.equal(result.sections[0].displayEndSeconds, 180);
  assert.equal(result.sections[0].endSeconds, null);
  assert.equal(result.sections[0].automaticSkipAllowed, false);
  assert.equal(result.tailContent, "unknown");
});

test("hidden parent does not hide a visible child; BCP47 replaces legacy language/country", async () => {
  const display = ebml(0x80, ebml(0x85, "Начало"), ebml(0x437c, "eng"), ebml(0x437d, "ru-RU"), ebml(0x437e, "us"));
  const bytes = mkv(ebml(0x1043a770, edition(atom(1, 0, "Parent", ebml(0x98, Buffer.from([1])),
    atom(2, 1000000000, "Child", display)))));
  const { held, container } = heldFile(bytes, MatroskaContainer);
  const result = await container.readChapters(held);
  assert.equal(result.sections.length, 1);
  assert.deepEqual(result.sections[0].titles[1].languages, ["ru-RU"]);
  assert.deepEqual(result.sections[0].titles[1].countries, []);
});

test("default ordered edition is retained but never flattened or silently replaced", async () => {
  const bytes = mkv(ebml(0x1043a770, edition(atom(1, 0, "Linear")),
    edition(ebml(0x45db, Buffer.from([1])), ebml(0x45dd, Buffer.from([1])), atom(2, 0, "Ordered", ebml(0x92, u64(1000000000))))));
  const { held, container } = heldFile(bytes, MatroskaContainer);
  const result = await container.readChapters(held);
  assert.equal(result.reason, "ordered-edition-playback");
  assert.equal(result.editions.length, 2);
  assert.equal(result.sections.length, 0);
});

test("ordered-only fields in ordinary chapters do not reject navigation", async () => {
  const bytes = mkv(ebml(0x1043a770, edition(atom(1, 0, "Part", ebml(0x6e67, Buffer.alloc(16)), ebml(0x6944, ebml(0x6955, Buffer.from([1])))))));
  const { held, container } = heldFile(bytes, MatroskaContainer);
  assert.equal((await container.readChapters(held)).state, "available");
});

test("chapters after a Cluster without SeekHead are found from headers", async () => {
  const bytes = mkv(ebml(0x1f43b675, Buffer.alloc(131072)), ebml(0x1043a770, edition(atom(1, 0, "Credits"))));
  const marker = bytes.indexOf(Buffer.from("1043a770", "hex"));
  const { held, container } = heldFile(bytes, MatroskaContainer, [[0, 31], [marker, bytes.length - 1]]);
  assert.equal((await container.readChapters(held)).sections[0].type, "credits");
});

test("SeekHead reaches chapters after media without reading Cluster bytes", async () => {
  const seek = (position) => ebml(0x114d9b74, ebml(0x4dbb,
    ebml(0x53ab, Buffer.from("1043a770", "hex")), ebml(0x53ac, u64(position))));
  const cluster = ebml(0x1f43b675, Buffer.alloc(131072));
  const bytes = mkv(seek(seek(0).length + cluster.length), cluster, ebml(0x1043a770, edition(atom(1, 0, "Scene"))));
  const marker = bytes.indexOf(Buffer.from("1043a770", "hex"), 64);
  const { held, container } = heldFile(bytes, MatroskaContainer, [[0, 63], [marker, bytes.length - 1]]);
  assert.equal((await container.readChapters(held)).sections[0].titles[0].text, "Scene");
});

test("walking available Cluster headers does not read video payloads", async () => {
  const bytes = mkv(...Array.from({ length: 150 }, () => ebml(0x1f43b675, Buffer.alloc(65536))),
    ebml(0x1043a770, edition(atom(1, 0, "Credits"))));
  const { held, container } = heldFile(bytes, MatroskaContainer);
  let requested = 0;
  held.read = async (start, end) => { requested += end - start + 1; return bytes.subarray(start, end + 1); };
  assert.equal((await container.readChapters(held)).state, "available");
  assert.ok(requested < 8192, `Read ${requested} bytes for header traversal`);
});

test("unknown-sized Cluster ends at next Segment-level chapter element", async () => {
  const bytes = Buffer.concat([ebml(0x1a45dfa3), Buffer.from("18538067ff1f43b675ff", "hex"), ebml(0xe7, Buffer.from([0])), ebml(0x1043a770, edition(atom(1, 0, "Scene")))]);
  const { held, container } = heldFile(bytes, MatroskaContainer);
  assert.equal((await container.readChapters(held)).state, "available");
});

test("missing traversal headers beyond media stay passive without a chapter location", async () => {
  const bytes = mkv(ebml(0x1f43b675, Buffer.alloc(131072)), ebml(0x1043a770, edition(atom(1, 0, "Scene"))));
  const { held, container } = heldFile(bytes, MatroskaContainer, [[0, 31]]);
  await assert.rejects(container.readChapters(held), (error) => error instanceof BytesUnavailable && error.passive === true);
});

test("missing chapter bytes are retryable, never absent", async () => {
  const bytes = mkv(ebml(0x1043a770, edition(atom(1, 0, "Scene"))));
  const { held, container } = heldFile(bytes, MatroskaContainer, [[0, 15]]);
  await assert.rejects(container.readChapters(held), BytesUnavailable);
  held.ranges = [[0, bytes.length - 1]];
  // The fake reader and range snapshot now both see the new bytes.
  held.read = async (start, end) => bytes.subarray(start, end + 1);
  assert.equal((await container.readChapters(held)).state, "available");
});

test("bad ranges and duplicate chapter identifiers reject malformed metadata", async () => {
  for (const fields of [edition(atom(1, 1000, "Scene", ebml(0x92, u64(999)))), edition(atom(1, 0, "Scene"), atom(1, 1000, "Other"))]) {
    const { held, container } = heldFile(mkv(ebml(0x1043a770, fields)), MatroskaContainer);
    await assert.rejects(container.readChapters(held));
  }
});

test("zero-length chapter marks and unnamed chapters survive", async () => {
  const { held, container } = heldFile(mkv(ebml(0x1043a770, edition(atom(1, 0, "", ebml(0x92, u64(0)))))), MatroskaContainer);
  const result = await container.readChapters(held);
  assert.equal(result.sections[0].endSeconds, 0);
  assert.equal(result.sections[0].type, "chapter");
});

test("MP4 chpl units differ from movie time scale and infer only navigation ends", async () => {
  const bytes = mp4(movie(), mpbox("udta", nero([0, "OP"], [30000000, "Story"])));
  const { held, container } = heldFile(bytes, Mp4Container);
  const result = await container.readChapters(held);
  assert.equal(result.sections[1].startSeconds, 3);
  assert.equal(result.sections[1].displayEndSeconds, 5);
  assert.equal(result.sections[0].endSeconds, null);
});

test("moov at head does not require headers or bytes after moov", async () => {
  const prefix = mp4(movie(), mpbox("udta", nero([0, "Scene"])));
  const bytes = Buffer.concat([prefix, mpbox("mdat", Buffer.alloc(200000))]);
  const { held, container } = heldFile(bytes, Mp4Container, [[0, prefix.length - 1]]);
  assert.equal((await container.readChapters(held)).state, "available");
});

function qtFile({ edits = null, co64 = false, title = "Opening", nameBytes = null, language = 0, format = "text", external = false, fragmentedTrack = null } = {}) {
  const name = nameBytes ?? Buffer.from(title), sample = Buffer.concat([u16(name.length), name]);
  const build = (offset) => {
    const tkhd = (id, enabled) => mpbox("tkhd", Buffer.from([0, 0, 0, enabled ? 1 : 0]), Buffer.alloc(8), u32(id));
    const owner = mpbox("trak", tkhd(1, true), mpbox("tref", mpbox("chap", u32(2))));
    const stsd = mpbox("stsd", Buffer.alloc(4), u32(1), mpbox(format, Buffer.alloc(6), u16(1)));
    const stbl = mpbox("stbl", stsd, mpbox("stsz", Buffer.alloc(4), u32(sample.length), u32(1)),
      table("stts", 2, [1, 1000]), table("stsc", 3, [1, 1, 1]), co64 ? mpbox("co64", Buffer.alloc(4), u32(1), u64(offset)) : table("stco", 1, [offset]));
    const minf = mpbox("minf", mpbox("dinf", mpbox("dref", Buffer.alloc(4), u32(1), mpbox("url ", Buffer.from([0, 0, 0, external ? 0 : 1])))), stbl);
    const mdhd = mpbox("mdhd", Buffer.alloc(12), u32(1000), u32(1000), u16(language));
    const track = mpbox("trak", tkhd(2, false), ...(edits ? [mpbox("edts", mpbox("elst", Buffer.alloc(4), u32(edits.length), ...edits.map(([duration, media]) => Buffer.concat([u32(duration), u32(media < 0 ? 0xffffffff : media), u16(1), u16(0)]))))] : []), mpbox("mdia", mdhd, minf));
    return mp4(movie(), owner, track, ...(fragmentedTrack === null ? [] : [mpbox("mvex", mpbox("trex", Buffer.alloc(4), u32(fragmentedTrack), Buffer.alloc(16)))]));
  };
  const prefix = build(0);
  return Buffer.concat([build(prefix.length + 8), mpbox("mdat", sample)]);
}

test("QuickTime chapter track is read by reference even when that track is disabled", async () => {
  const { held, container } = heldFile(qtFile({ co64: true }), Mp4Container);
  const result = await container.readChapters(held);
  assert.equal(result.sections[0].titles[0].text, "Opening");
  assert.equal(result.sections[0].startSeconds, 0);
  assert.equal(result.sections[0].endSeconds, 1);
});

test("fragmented chapter samples are refused without claiming absence or completeness", async () => {
  const { held, container } = heldFile(qtFile({ fragmentedTrack: 2 }), Mp4Container);
  await assert.rejects(container.readChapters(held), /chapter-fragmented-track/);
});

test("fragmented video does not reject an ordinary chapter track", async () => {
  const { held, container } = heldFile(qtFile({ fragmentedTrack: 1 }), Mp4Container);
  assert.equal((await container.readChapters(held)).state, "available");
});

test("QuickTime legacy English uses Macintosh encoding while tx3g uses Unicode", async () => {
  for (const [format, nameBytes] of [["text", Buffer.from([0x43, 0x61, 0x66, 0x8e])], ["tx3g", Buffer.from("Café")]]) {
    const { held, container } = heldFile(qtFile({ format, nameBytes }), Mp4Container);
    assert.equal((await container.readChapters(held)).sections[0].titles[0].text, "Café");
  }
});

test("QuickTime text refuses an unsupported Macintosh encoding explicitly", async () => {
  const { held, container } = heldFile(qtFile({ language: 11 }), Mp4Container);
  await assert.rejects(container.readChapters(held), /chapter-text-encoding:11/);
});

test("QuickTime empty edit and repeated edits map chapter samples into movie time", async () => {
  const { held, container } = heldFile(qtFile({ edits: [[2000, -1], [1000, 0], [1000, 0]] }), Mp4Container);
  const result = await container.readChapters(held);
  assert.deepEqual(result.sections.map((item) => [item.startSeconds, item.endSeconds]), [[2, 3], [3, 4]]);
});

test("QuickTime edits retain the chapter active at a trimmed media start", async () => {
  const { held, container } = heldFile(qtFile({ edits: [[500, 500]] }), Mp4Container);
  const result = await container.readChapters(held);
  assert.deepEqual(result.sections.map((item) => [item.startSeconds, item.endSeconds]), [[0, 0.5]]);
});

test("external chapter data is refused rather than fetched", async () => {
  const { held, container } = heldFile(qtFile({ external: true }), Mp4Container);
  await assert.rejects(container.readChapters(held), /external-chapter-data-reference/);
});

test("ordinary navigation end does not prove a later scene is absent", () => {
  const section = navigationSections({ chapters: [{ id: "1", startSeconds: 0, endSeconds: null, enabled: true, hidden: false, titles: [{ text: "Credits" }], children: [] }] }, 100)[0];
  assert.equal(section.endSource, "navigation");
  assert.equal(section.automaticSkipAllowed, false);
});

test("orchestrator shares reads, retries on bytes, emits changes only for changed answers", async () => {
  const bytes = mkv(ebml(0x1043a770, edition(atom(1, 0, "Scene"))));
  let ranges = [[0, 15]], calls = 0;
  const changes = [];
  const containers = new ContainerOrchestrator();
  const requests = new MediaReadRequests({ read: (params, statement) => containers.inspect(params, statement) });
  const readHeld = async (start, end) => { calls++; return ranges.some(([a, b]) => start >= a && end <= b) ? bytes.subarray(start, end + 1) : null; };
  const orchestrator = new ChapterOrchestrator({ containers, subscribe: (source, file, listener) => requests.subscribe(source, file, listener),
    onChanged: (event) => changes.push(event), fileFor: async () => {
    const params = {
    sourceKey: "source", fileIndex: 0, fileSize: bytes.length,
    readRange: readHeld, heldRanges: async () => ranges, readHeld,
    onReadResult: (statement, result) => requests.record(params, statement, result)
    };
    return params;
  } });
  orchestrator.get("source", 0); orchestrator.get("source", 0);
  await orchestrator.files.get("source:0").reading;
  assert.equal(orchestrator.get("source", 0).state, "pending");
  await orchestrator.files.get("source:0").reading;
  const before = calls;
  orchestrator.get("source", 0);
  await orchestrator.files.get("source:0").reading;
  assert.equal(calls, before);
  ranges = [[0, bytes.length - 1]];
  requests.bytesChanged("source", 0);
  for (let attempt = 0; attempt < 30 && orchestrator.get("source", 0).state !== "available"; attempt++) await settle();
  assert.equal(orchestrator.get("source", 0).state, "available");
  assert.equal(changes.length, 2);
});

test("forgotten in-flight read cannot repopulate the file result", async () => {
  let finish;
  const orchestrator = new ChapterOrchestrator({ containers: {}, fileFor: () => new Promise((resolve) => { finish = resolve; }) });
  orchestrator.get("source", 0);
  const work = orchestrator.files.get("source:0").reading;
  orchestrator.forget("source", 0);
  finish(null); await work;
  assert.equal(orchestrator.files.size, 0);
});

test("withdrawn chapter read cannot reserve memory after its last byte arrives", async () => {
  let finish, current = true, accepted = false;
  const containers = new ContainerOrchestrator();
  containers.cache.set("source:0", { readChapters: () => new Promise((resolve) => { finish = resolve; }) });
  const work = containers.inspect({ sourceKey: "source", fileIndex: 0, isCurrent: () => current,
    acceptChapterResult: () => { accepted = true; } }, "chapters");
  await settle();
  current = false;
  finish({ version: 1, state: "available", complete: true });
  assert.equal((await work).reason, "request-obsolete");
  assert.equal(accepted, false);
});

test("chapter snapshot waits for its shared memory budget and releases its retained bytes", async () => {
  const bytes = mkv(ebml(0x1043a770, edition(atom(1, 0, "Scene"))));
  const containers = new ContainerOrchestrator();
  const requests = new MediaReadRequests({ read: (params, statement) => containers.inspect(params, statement) });
  const memory = new IndexMemory({ reviseBudget: () => {}, changed: () => requests.memoryChanged() });
  const orchestrator = new ChapterOrchestrator({ containers, fileFor: async () => {
    const params = { sourceKey: "source", fileIndex: 0, fileSize: bytes.length,
      readRange: async (start, end) => bytes.subarray(start, end + 1), packetMemory: memory.forFile("source", 0),
      onReadResult: (statement, result) => requests.record(params, statement, result) };
    return params;
  } });
  orchestrator.get("source", 0);
  await orchestrator.files.get("source:0").reading;
  assert.equal(orchestrator.get("source", 0).resource, "memory");
  assert.equal(memory.held(), 0);
  memory.allow(memory.wanted());
  for (let attempt = 0; attempt < 30 && orchestrator.get("source", 0).state !== "available"; attempt++) await settle();
  assert.equal(orchestrator.get("source", 0).state, "available");
  assert.equal(memory.held(), orchestrator.files.get("source:0").buffer.length);
  orchestrator.forget("source", 0);
  assert.equal(memory.held(), 0);
});

test("route rejects missing index and does not await discovery", () => {
  const controller = new ChapterController({ sourceRegistry: { get: () => ({}) }, chapters: { get: () => ({ state: "pending" }) } });
  let status, body;
  const reply = { header: () => reply, code: (value) => { status = value; return reply; }, send: (value) => { body = value; } };
  handleApiSourceChaptersGet({ params: { sourceKey: "source" }, query: {} }, reply, { chapterController: controller });
  assert.equal(status, 400);
  handleApiSourceChaptersGet({ params: { sourceKey: "source" }, query: { fileIndex: "0" } }, reply, { chapterController: controller });
  assert.equal(body.state, "pending");
});

test("container forget prevents stale detection from repopulating its cache", async () => {
  const containers = new ContainerOrchestrator();
  let finish;
  const work = containers.containerFor({ sourceKey: "source", fileIndex: 0, fileSize: 16, readRange: () => new Promise((resolve) => { finish = resolve; }) });
  await settle();
  containers.forget("source", 0);
  finish(Buffer.alloc(16)); await assert.rejects(work, /withdrawn/);
  assert.equal(containers.known("source", 0), undefined);
});
