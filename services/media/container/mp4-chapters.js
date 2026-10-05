/** QuickTime Chapter Lists and ISO/IEC 14496-12 sample tables/edit lists. */
import { isUnavailable } from "./unavailable.js";
import { ChapterBytes, ChapterUnsupported, CHAPTER_LIMITS, chapterResult, chapterSeconds, navigationSections } from "./chapters.js";

async function box(reader, at, end) {
  reader.step();
  const bytes = await reader.bytes(at, 8);
  let size = bytes.readUInt32BE(0), header = 8;
  if (size === 1) { size = Number((await reader.bytes(at + 8, 8)).readBigUInt64BE()); header = 16; }
  if (size === 0) size = end - at;
  if (!Number.isSafeInteger(size) || size < header || at + size > end) throw new Error("Chapter box exceeds its parent");
  return { type: bytes.toString("latin1", 4, 8), at, dataOffset: at + header, end: at + size };
}

async function boxes(reader, start, end) {
  const result = [];
  for (let at = start; at < end;) {
    if (end - at < 8) throw new Error("Truncated chapter box header");
    const child = await box(reader, at, end);
    result.push(child);
    at = child.end;
  }
  return result;
}

const one = (list, type) => list.find((field) => field.type === type);
async function inside(reader, parent) { return parent ? boxes(reader, parent.dataOffset, parent.end) : []; }
async function payload(reader, field, count) {
  if (!field || field.dataOffset + count > field.end) throw new Error("Truncated chapter field");
  return reader.bytes(field.dataOffset, count);
}
async function table(reader, field, width, prefix = 8) {
  const head = await payload(reader, field, prefix);
  const count = head.readUInt32BE(prefix - 4);
  if (count > CHAPTER_LIMITS.entries) throw new ChapterUnsupported("chapter-sample-table-budget");
  if (field.dataOffset + prefix + width * count !== field.end) throw new Error("Chapter sample table size mismatch");
  return { head, count, bytes: await reader.bytes(field.dataOffset + prefix, count * width) };
}

function titleOf(bytes) {
  if (bytes.length > CHAPTER_LIMITS.textBytes) throw new ChapterUnsupported("chapter-title-budget");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\0+$/, "");
}

const MAC_LANGUAGES = new Map([[0, "eng"], [1, "fra"], [2, "deu"], [3, "ita"],
  [4, "nld"], [5, "swe"], [6, "spa"], [7, "dan"], [8, "por"], [9, "nor"], [13, "fin"], [32, "rus"]]);

function trackTitle(bytes, format, languageCode) {
  if (bytes.length > CHAPTER_LIMITS.textBytes) throw new ChapterUnsupported("chapter-title-budget");
  const bom = bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe));
  if (format === "tx3g" || bom || (languageCode >= 0x400 && languageCode !== 0x7fff)) return titleOf(bytes);
  if (!MAC_LANGUAGES.has(languageCode)) throw new ChapterUnsupported(`chapter-text-encoding:${languageCode}`);
  return new TextDecoder(languageCode === 32 ? "x-mac-cyrillic" : "macintosh", { fatal: true }).decode(bytes).replace(/\0+$/, "");
}

function chapter(id, start, end, title, language = "und", order = 0) {
  return { id, parentId: null, order, startSeconds: start, endSeconds: end,
    titles: [{ text: title, languages: [language], countries: [], languageSource: "mp4" }], hidden: false, enabled: true, children: [] };
}

async function nero(reader, field) {
  const initial = await payload(reader, field, 4);
  const version = initial[0];
  if (version > 1) throw new ChapterUnsupported("chpl-version");
  const prefix = version === 1 ? 9 : 5;
  const count = (await payload(reader, field, prefix))[prefix - 1];
  let at = field.dataOffset + prefix;
  const chapters = [];
  for (let index = 0; index < count; index++) {
    if (at + 9 > field.end) throw new Error("Truncated chpl entry");
    const head = await reader.bytes(at, 9);
    const time = head.readBigUInt64BE(0), length = head[8];
    at += 9;
    if (at + length > field.end) throw new Error("Truncated chpl title");
    chapters.push({ ...chapter(`mp4:chpl:${index}`, chapterSeconds(time, 10000000), null,
      titleOf(await reader.bytes(at, length)), "und", index), timeTicks: String(time), timeScale: 10000000 });
    at += length;
  }
  if (at !== field.end) throw new Error("Unexpected bytes after chpl entries");
  return { id: "mp4:chpl", source: "chpl", ordered: false, chapters };
}

async function timedHeader(reader, field) {
  const first = await payload(reader, field, 4);
  if (first[0] > 1) throw new ChapterUnsupported("mp4-time-header-version");
  const wide = first[0] === 1;
  const data = await payload(reader, field, wide ? 32 : 20);
  const scale = data.readUInt32BE(wide ? 20 : 12);
  const duration = wide ? data.readBigUInt64BE(24) : BigInt(data.readUInt32BE(16));
  if (scale === 0) throw new Error("Zero chapter time scale");
  return { scale, duration, wide };
}

async function trackInfo(reader, field) {
  const parts = await inside(reader, field);
  const tkhd = one(parts, "tkhd");
  const first = await payload(reader, tkhd, 4);
  if (first[0] > 1) throw new ChapterUnsupported("tkhd-version");
  const data = await payload(reader, tkhd, first[0] === 1 ? 24 : 16);
  const id = data.readUInt32BE(first[0] === 1 ? 20 : 12);
  const enabled = (first.readUIntBE(1, 3) & 1) !== 0;
  const references = await inside(reader, one(parts, "tref"));
  const refs = [];
  for (const ref of references.filter((item) => item.type === "chap")) {
    const size = ref.end - ref.dataOffset;
    if (size % 4 || size / 4 > CHAPTER_LIMITS.entries) throw new Error("Invalid chap references");
    const values = await payload(reader, ref, size);
    for (let at = 0; at < size; at += 4) refs.push(values.readUInt32BE(at));
  }
  return { id, enabled, refs, parts };
}

async function sizesOf(reader, fields) {
  const stsz = one(fields, "stsz");
  if (stsz) {
    const head = await payload(reader, stsz, 12);
    const uniform = head.readUInt32BE(4), count = head.readUInt32BE(8);
    if (count > CHAPTER_LIMITS.entries) throw new ChapterUnsupported("chapter-sample-count");
    if (stsz.dataOffset + 12 + (uniform ? 0 : 4 * count) !== stsz.end) throw new Error("Invalid chapter stsz");
    const values = uniform ? null : await reader.bytes(stsz.dataOffset + 12, count * 4);
    return Array.from({ length: count }, (_, index) => uniform || values.readUInt32BE(index * 4));
  }
  const compact = one(fields, "stz2");
  const head = await payload(reader, compact, 12);
  const width = head[7], count = head.readUInt32BE(8);
  if (![4, 8, 16].includes(width)) throw new Error("Invalid stz2 field size");
  if (count > CHAPTER_LIMITS.entries) throw new ChapterUnsupported("chapter-sample-count");
  const length = Math.ceil(width * count / 8);
  if (compact.dataOffset + 12 + length !== compact.end) throw new Error("Invalid chapter stz2");
  const values = await reader.bytes(compact.dataOffset + 12, length);
  return Array.from({ length: count }, (_, index) => width === 16 ? values.readUInt16BE(index * 2)
    : width === 8 ? values[index] : index % 2 ? values[index >> 1] & 15 : values[index >> 1] >> 4);
}

async function editMap(reader, parts, movieScale, trackScale, trackDuration) {
  const edts = await inside(reader, one(parts, "edts"));
  const elst = one(edts, "elst");
  if (!elst) return [{ media: 0, movie: 0, duration: chapterSeconds(trackDuration, trackScale), index: 0 }];
  const version = (await payload(reader, elst, 4))[0];
  if (version > 1) throw new ChapterUnsupported("chapter-edit-version");
  const width = version === 1 ? 20 : 12;
  const entries = await table(reader, elst, width);
  let movie = 0;
  const result = [];
  for (let index = 0; index < entries.count; index++) {
    const at = index * width;
    const duration = chapterSeconds(version === 1 ? entries.bytes.readBigUInt64BE(at) : BigInt(entries.bytes.readUInt32BE(at)), movieScale);
    const media = version === 1 ? entries.bytes.readBigInt64BE(at + 8) : BigInt(entries.bytes.readInt32BE(at + 4));
    const rate = version === 1 ? at + 16 : at + 8;
    if (entries.bytes.readInt16BE(rate) !== 1 || entries.bytes.readInt16BE(rate + 2) !== 0) throw new ChapterUnsupported("chapter-edit-rate");
    if (media < -1n) throw new Error("Invalid chapter edit media time");
    if (media !== -1n) result.push({ media: chapterSeconds(media, trackScale), movie, duration, index });
    movie += duration;
  }
  return result;
}

async function quicktime(reader, track, movieScale) {
  const mdia = await inside(reader, one(track.parts, "mdia"));
  const timing = await timedHeader(reader, one(mdia, "mdhd"));
  const mdhd = await payload(reader, one(mdia, "mdhd"), timing.wide ? 34 : 22);
  const lang = mdhd.readUInt16BE(timing.wide ? 32 : 20);
  let language = lang ? String.fromCharCode(((lang >> 10) & 31) + 96, ((lang >> 5) & 31) + 96, (lang & 31) + 96) : "und";
  if (lang < 0x400) language = MAC_LANGUAGES.get(lang) ?? "und";
  if (!/^[a-z]{3}$/.test(language)) language = "und";
  const elng = one(mdia, "elng");
  if (elng) {
    await payload(reader, elng, 4);
    language = titleOf(await reader.bytes(elng.dataOffset + 4, elng.end - elng.dataOffset - 4)) || language;
  }
  const minf = await inside(reader, one(mdia, "minf"));
  const dinf = await inside(reader, one(minf, "dinf"));
  const dref = one(dinf, "dref");
  const dataRefs = dref ? await boxes(reader, dref.dataOffset + 8, dref.end) : [];
  if (dref && (await payload(reader, dref, 8)).readUInt32BE(4) !== dataRefs.length) throw new Error("Chapter data reference count mismatch");
  const fields = await inside(reader, one(minf, "stbl"));
  const stsd = one(fields, "stsd");
  if (!stsd) throw new Error("Chapter track has no sample descriptions");
  const descriptions = await boxes(reader, stsd.dataOffset + 8, stsd.end);
  if ((await payload(reader, stsd, 8)).readUInt32BE(4) !== descriptions.length) throw new Error("Chapter sample description count mismatch");
  if (!descriptions.length) throw new Error("Chapter track has no sample description");
  for (const description of descriptions) {
    if (!["text", "tx3g"].includes(description.type)) throw new ChapterUnsupported(`chapter-sample-format:${description.type}`);
    const reference = (await payload(reader, description, 8)).readUInt16BE(6);
    const source = dataRefs[reference - 1];
    if (!source || !["url ", "alis"].includes(source.type) || ((await payload(reader, source, 4)).readUIntBE(1, 3) & 1) === 0) {
      throw new ChapterUnsupported("external-chapter-data-reference");
    }
  }
  const sizes = await sizesOf(reader, fields);
  const durations = await table(reader, one(fields, "stts"), 8);
  const times = [];
  let ticks = 0n;
  for (let index = 0; index < durations.count; index++) {
    const count = durations.bytes.readUInt32BE(index * 8), delta = BigInt(durations.bytes.readUInt32BE(index * 8 + 4));
    if (times.length + count > sizes.length) throw new Error("stts exceeds chapter sample count");
    for (let sample = 0; sample < count; sample++) { times.push({ start: ticks, end: ticks + delta }); ticks += delta; }
  }
  if (times.length !== sizes.length) throw new Error("stts does not cover chapter samples");
  const ctts = one(fields, "ctts");
  if (ctts) {
    const offsets = await table(reader, ctts, 8);
    if (offsets.head[0] > 1) throw new ChapterUnsupported("chapter-ctts-version");
    let sample = 0;
    for (let index = 0; index < offsets.count; index++) {
      const count = offsets.bytes.readUInt32BE(index * 8);
      const offset = BigInt(offsets.head[0] === 1 ? offsets.bytes.readInt32BE(index * 8 + 4) : offsets.bytes.readUInt32BE(index * 8 + 4));
      if (sample + count > times.length) throw new Error("ctts exceeds chapter samples");
      for (let n = 0; n < count; n++, sample++) { times[sample].start += offset; times[sample].end += offset; }
    }
    if (sample !== times.length) throw new Error("ctts does not cover chapter samples");
  }
  const chunksField = one(fields, "stco") ?? one(fields, "co64");
  const wide = chunksField?.type === "co64";
  const chunks = await table(reader, chunksField, wide ? 8 : 4);
  const runs = await table(reader, one(fields, "stsc"), 12);
  const locations = [];
  const formats = [];
  let run = 0, sample = 0;
  const runAt = (index) => ({ first: runs.bytes.readUInt32BE(index * 12), count: runs.bytes.readUInt32BE(index * 12 + 4), description: runs.bytes.readUInt32BE(index * 12 + 8) });
  if (chunks.count && (!runs.count || runAt(0).first !== 1)) throw new Error("Invalid first chapter chunk mapping");
  for (let index = 0; index < runs.count; index++) {
    const current = runAt(index);
    if (!current.count || current.description < 1 || current.description > descriptions.length || current.first > chunks.count || (index && current.first <= runAt(index - 1).first)) throw new Error("Invalid chapter chunk mapping");
  }
  for (let index = 0; index < chunks.count; index++) {
    if (run + 1 < runs.count && runAt(run + 1).first === index + 1) run++;
    let at = wide ? Number(chunks.bytes.readBigUInt64BE(index * 8)) : chunks.bytes.readUInt32BE(index * 4);
    for (let n = 0; n < runAt(run).count; n++, sample++) {
      if (sample >= sizes.length || !Number.isSafeInteger(at) || at < 0 || at + sizes[sample] > reader.size) throw new Error("Chapter sample outside file or count");
      locations.push(at); formats.push(descriptions[runAt(run).description - 1].type); at += sizes[sample];
    }
  }
  if (locations.length !== sizes.length) throw new Error("Chunk table does not cover chapter samples");
  const edits = await editMap(reader, track.parts, movieScale, timing.scale, timing.duration);
  const chapters = [];
  for (let index = 0; index < sizes.length; index++) {
    if (sizes[index] < 2 || sizes[index] > CHAPTER_LIMITS.textBytes + 65536) throw new ChapterUnsupported("chapter-text-sample-size");
    const head = await reader.bytes(locations[index], 2);
    const length = head.readUInt16BE();
    if (length + 2 > sizes[index]) throw new Error("Chapter text exceeds sample");
    const title = trackTitle(await reader.bytes(locations[index] + 2, length), formats[index], lang);
    const start = chapterSeconds(times[index].start, timing.scale), end = chapterSeconds(times[index].end, timing.scale);
    for (const edit of edits) {
      if (end <= edit.media || start >= edit.media + edit.duration) continue;
      chapters.push(chapter(`mp4:track:${track.id}:sample:${index}:edit:${edit.index}`,
        edit.movie + Math.max(start - edit.media, 0), edit.movie + Math.min(end - edit.media, edit.duration), title, language, chapters.length));
    }
  }
  return { id: `mp4:track:${track.id}`, source: "quicktime", ordered: false, chapters };
}

export async function readMp4Chapters(container, held) {
  const cached = container.moovHeld;
  const originalRead = held.read;
  const ranges = held.ranges ? [...held.ranges] : undefined;
  if (cached?.offset !== undefined) ranges?.push([cached.offset, cached.offset + cached.moov.length - 1]);
  const reader = new ChapterBytes({ ...held, ranges, read: (start, end) => {
    if (cached?.offset !== undefined && start >= cached.offset && end < cached.offset + cached.moov.length) return Promise.resolve(cached.moov.subarray(start - cached.offset, end - cached.offset + 1));
    return originalRead(start, end);
  } }, container.fileSize);
  let moov = null;
  for (let at = 0; at < reader.size;) {
    const field = await box(reader, at, reader.size);
    if (field.type === "moov") { moov = field; break; }
    at = field.end;
  }
  if (!moov) return chapterResult("absent");
  const parts = await inside(reader, moov);
  const udta = await inside(reader, one(parts, "udta"));
  const chpl = one(udta, "chpl");
  const editions = [];
  if (chpl) editions.push(await nero(reader, chpl));
  let pending = null;
  try {
    const tracks = [];
    for (const field of parts.filter((part) => part.type === "trak")) tracks.push(await trackInfo(reader, field));
    const referrer = tracks.find((track) => track.enabled && track.refs.length);
    if (referrer) {
      const track = tracks.find((item) => item.id === referrer.refs[0]);
      if (!track) throw new Error("Referenced chapter track is missing");
      const timing = await timedHeader(reader, one(parts, "mvhd"));
      editions.unshift(await quicktime(reader, track, timing.scale));
    }
  } catch (error) {
    if (!editions.length) throw error;
    if (isUnavailable(error)) pending = { state: "pending", start: error.start, end: error.end };
    else throw error;
  }
  const selected = editions[0];
  if (!selected || !selected.chapters.length) return chapterResult(pending ? "pending" : "absent", { editions, pending,
    selectedEditionId: selected?.id ?? null });
  let duration = container.mediaInfo?.durationSeconds ?? null;
  if (duration === null && one(parts, "mvhd")) {
    const timing = await timedHeader(reader, one(parts, "mvhd"));
    if (timing.duration !== (timing.wide ? 0xffffffffffffffffn : 0xffffffffn)) duration = chapterSeconds(timing.duration, timing.scale);
  }
  return chapterResult("available", { editions, selectedEditionId: selected.id, complete: pending === null,
    pending, representationsDisagree: editions.length > 1 && JSON.stringify(editions[0].chapters.map((item) => [item.startSeconds, item.titles[0].text])) !== JSON.stringify(editions[1].chapters.map((item) => [item.startSeconds, item.titles[0].text])),
    sections: navigationSections(selected, duration) });
}
