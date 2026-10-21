/** RFC 9559 §§5.1.7, 6.6, 11.1.1 and 20: chapter metadata only. */
import { readVint } from "./ebml-reader.js";
import { ChapterBytes, ChapterUnsupported, CHAPTER_LIMITS, chapterResult, chapterSeconds, navigationSections } from "./chapters.js";

const SEGMENT = 0x18538067;
const CHAPTERS = 0x1043a770;
const SEEK_HEAD = 0x114d9b74;
const CLUSTER = 0x1f43b675;
const TOP_LEVEL = new Set([SEEK_HEAD, CHAPTERS, CLUSTER, 0x1549a966, 0x1654ae6b, 0x1c53bb6b, 0x1941a469, 0x1254c367]);

async function header(reader, at, limit) {
  reader.step();
  const vint = async (position, marker) => {
    const firstBytes = await reader.bytes(position, 1);
    const first = firstBytes[0];
    let n = 1;
    while (n <= 8 && !(first & (0x80 >> (n - 1)))) n++;
    if (n > (marker ? 4 : 8) || position + n > limit) throw new Error("Invalid chapter EBML header");
    const bytes = n === 1 ? firstBytes : Buffer.concat([firstBytes, await reader.bytes(position + 1, n - 1)]);
    const value = readVint(bytes, 0, marker);
    const mask = 2 ** (8 - n) - 1;
    return { ...value, unknown: !marker && (bytes[0] & mask) === mask && bytes.subarray(1).every((byte) => byte === 255) };
  };
  const id = await vint(at, true);
  const size = await vint(at + id.length, false);
  const dataOffset = at + id.length + size.length;
  const unknown = size.unknown;
  const end = unknown ? null : dataOffset + size.value;
  if (!Number.isSafeInteger(dataOffset) || (!unknown && (!Number.isSafeInteger(end) || end > limit))) throw new Error("Chapter element exceeds its parent");
  return { id: id.value, at, dataOffset, end, size: unknown ? null : size.value };
}

async function* children(reader, master, depth = 0) {
  reader.step(depth);
  if (master.end === null) throw new Error("Unknown size is not valid for this chapter element");
  for (let at = master.dataOffset; at < master.end;) {
    const child = await header(reader, at, master.end);
    if (child.end === null) throw new Error("Unknown-sized chapter child");
    yield child;
    at = child.end;
  }
}

async function integer(reader, field, fallback = null) {
  if (field.size > 8) throw new Error("Chapter integer exceeds eight bytes");
  if (field.size === 0) return fallback;
  const bytes = await reader.bytes(field.dataOffset, field.size);
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  return value;
}

async function text(reader, field) {
  if (field.size > CHAPTER_LIMITS.textBytes) throw new ChapterUnsupported("chapter-title-budget");
  return new TextDecoder("utf-8", { fatal: true }).decode(await reader.bytes(field.dataOffset, field.size)).replace(/\0+$/, "");
}

async function display(reader, field, depth) {
  let value = null;
  const languages = [], bcp47 = [], countries = [];
  for await (const part of children(reader, field, depth)) {
    if (part.id === 0x85) value = await text(reader, part);
    if (part.id === 0x437c) languages.push(await text(reader, part));
    if (part.id === 0x437d) bcp47.push(await text(reader, part));
    if (part.id === 0x437e) countries.push(await text(reader, part));
  }
  if (value === null) throw new Error("ChapterDisplay has no ChapString");
  return { text: value, languages: bcp47.length ? bcp47 : languages.length ? languages : ["eng"],
    countries: bcp47.length ? [] : countries, languageSource: bcp47.length ? "bcp47" : "matroska" };
}

async function atom(reader, field, editionId, parentId, count, depth) {
  if (++count.value > CHAPTER_LIMITS.entries) throw new ChapterUnsupported("chapter-count-budget");
  let uid = null, start = null, end = null, linkedSegment = null, linkedEdition = null;
  let hidden = false, enabled = true;
  const titles = [], childFields = [], trackNumbers = [], processCodecs = [];
  for await (const part of children(reader, field, depth)) {
    if (part.id === 0x73c4) uid = await integer(reader, part);
    if (part.id === 0x91) start = await integer(reader, part, 0n);
    if (part.id === 0x92) end = await integer(reader, part, 0n);
    if (part.id === 0x98) hidden = (await integer(reader, part, 0n)) !== 0n;
    if (part.id === 0x4598) enabled = (await integer(reader, part, 1n)) !== 0n;
    if (part.id === 0x6e67) {
      if (part.size !== 16) throw new Error("ChapterSegmentUUID must contain sixteen bytes");
      linkedSegment = (await reader.bytes(part.dataOffset, part.size)).toString("hex");
    }
    if (part.id === 0x6ebc) linkedEdition = String(await integer(reader, part));
    if (part.id === 0x80) titles.push(await display(reader, part, depth + 1));
    if (part.id === 0xb6) childFields.push(part);
    if (part.id === 0x8f) {
      for await (const track of children(reader, part, depth + 1)) if (track.id === 0x89) trackNumbers.push(String(await integer(reader, track)));
    }
    if (part.id === 0x6944) {
      let codec = 0n;
      for await (const command of children(reader, part, depth + 1)) if (command.id === 0x6955) codec = await integer(reader, command, 0n);
      processCodecs.push(String(codec));
    }
  }
  if (uid === null || uid === 0n || start === null) throw new Error("ChapterAtom requires a nonzero ChapterUID and ChapterTimeStart");
  if (end !== null && end < start) throw new Error("ChapterTimeEnd precedes ChapterTimeStart");
  const id = `${editionId}:chapter:${uid}`;
  const chapter = { id, uid: String(uid), editionId, parentId, order: count.value,
    startNanoseconds: String(start), endNanoseconds: end === null ? null : String(end),
    startSeconds: chapterSeconds(start, 1e9), endSeconds: end === null ? null : chapterSeconds(end, 1e9),
    hidden, enabled, titles, linkedSegment, linkedEdition, trackNumbers, processCodecs, children: [] };
  for (const child of childFields) {
    const nested = await atom(reader, child, editionId, id, count, depth + 1);
    if (BigInt(nested.startNanoseconds) < start || (end !== null && BigInt(nested.startNanoseconds) > end)) throw new Error("Nested chapter starts outside its parent");
    chapter.children.push(nested);
  }
  return chapter;
}

async function editionsOf(reader, chapters) {
  const editions = [], count = { value: 0 };
  for await (const field of children(reader, chapters)) {
    if (field.id !== 0x45b9) continue;
    let uid = null, hidden = false, isDefault = false, ordered = false;
    const atoms = [];
    for await (const part of children(reader, field, 1)) {
      if (part.id === 0x45bc) uid = await integer(reader, part);
      if (part.id === 0x45bd) hidden = (await integer(reader, part, 0n)) !== 0n;
      if (part.id === 0x45db) isDefault = (await integer(reader, part, 0n)) !== 0n;
      if (part.id === 0x45dd) ordered = (await integer(reader, part, 0n)) !== 0n;
      if (part.id === 0xb6) atoms.push(part);
    }
    const id = uid === null ? `matroska:edition-at:${field.at}` : `matroska:edition:${uid}`;
    const edition = { id, uid: uid === null ? null : String(uid), hidden, isDefault, ordered, chapters: [] };
    for (const part of atoms) edition.chapters.push(await atom(reader, part, id, null, count, 2));
    if (!edition.chapters.length) throw new Error("EditionEntry has no ChapterAtom");
    editions.push(edition);
  }
  if (!editions.length) throw new Error("Chapters has no EditionEntry");
  const ids = new Set();
  const check = (chapters) => {
    for (const chapter of chapters) {
      if (ids.has(chapter.uid)) throw new Error("Duplicate ChapterUID");
      ids.add(chapter.uid); check(chapter.children);
    }
  };
  for (const edition of editions) check(edition.chapters);
  return editions;
}

export async function readMatroskaChapters(container, held) {
  const reader = new ChapterBytes(held, container.fileSize);
  let at = 0, segment = null;
  while (at < reader.size) {
    const field = await header(reader, at, reader.size);
    if (field.id === SEGMENT) { segment = field; break; }
    if (field.end === null) throw new Error("Unknown-sized element before Segment");
    at = field.end;
  }
  if (!segment) throw new Error("Matroska Segment is missing");
  const limit = segment.end ?? reader.size;
  const visits = new Set();
  const seekHeads = [];
  const seek = async (field) => {
    if (visits.has(field.at)) return null;
    visits.add(field.at);
    for await (const entry of children(reader, field)) {
      if (entry.id !== 0x4dbb) continue;
      let id = null, position = null;
      for await (const part of children(reader, entry)) {
        if (part.id === 0x53ab) id = await integer(reader, part);
        if (part.id === 0x53ac) position = await integer(reader, part, 0n);
      }
      if (id === null || position === null) throw new Error("Incomplete chapter Seek entry");
      if (id !== BigInt(CHAPTERS) && id !== BigInt(SEEK_HEAD)) continue;
      const offset = segment.dataOffset + Number(position);
      if (!Number.isSafeInteger(offset) || offset < segment.dataOffset || offset >= limit) throw new Error("Chapter SeekPosition is outside Segment");
      reader.passiveMissing = false;
      const target = await header(reader, offset, limit);
      if (BigInt(target.id) !== id) throw new Error("Chapter SeekID does not match its target");
      if (target.id === CHAPTERS) return target;
      seekHeads.push(target);
    }
    return null;
  };
  let chapters = null;
  let passedCluster = false;
  at = segment.dataOffset;
  while (at < limit && !chapters) {
    // Without a declared location, traversing unavailable media must not
    // download every Cluster just to discover whether chapters follow it.
    reader.passiveMissing = passedCluster;
    const field = await header(reader, at, limit);
    reader.passiveMissing = false;
    if (field.id === CHAPTERS) { chapters = field; break; }
    if (field.id === CLUSTER) passedCluster = true;
    if (field.id === SEEK_HEAD) {
      chapters = await seek(field);
      while (!chapters && seekHeads.length) chapters = await seek(seekHeads.shift());
      if (chapters) break;
    }
    if (field.end !== null) { at = field.end; continue; }
    if (field.id !== CLUSTER) throw new Error("Unknown-sized non-Cluster element inside Segment");
    // An unknown-sized Cluster ends at the next Segment-level element (RFC 8794 §6.2).
    at = field.dataOffset;
    reader.passiveMissing = true;
    while (at < limit) {
      const child = await header(reader, at, limit);
      if (TOP_LEVEL.has(child.id)) break;
      if (child.end === null) throw new ChapterUnsupported("unknown-sized-cluster-child");
      at = child.end;
    }
  }
  if (!chapters) return chapterResult("absent");
  const editions = await editionsOf(reader, chapters);
  const selected = editions.find((edition) => edition.isDefault) ?? editions[0];
  if (selected.ordered) return chapterResult("unsupported", { reason: "ordered-edition-playback", editions, selectedEditionId: selected.id });
  return chapterResult("available", { editions, selectedEditionId: selected.id,
    sections: navigationSections(selected, container.mediaInfo?.durationSeconds ?? null) });
}
