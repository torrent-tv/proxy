import { Readable } from "node:stream";

function mediaRange(header, length) {
  if (!header) return { start: 0, end: length - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, length - suffix), end: length - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || end < start) return null;
  return { start, end: Math.min(end, length - 1) };
}

/** Serve existing downloaded bytes without creating source demand. */
export async function handleMediaGet(req, reply, { torrentPool, onMissing = () => {} }) {
  const sourceKey = typeof req.query?.sourceKey === "string" ? req.query.sourceKey : "";
  const rawIndex = String(req.query?.fileIndex ?? "");
  if (!sourceKey || !/^\d+$/.test(rawIndex)) {
    return reply.code(400).send({ error: "A source and file index are required." });
  }
  const fileIndex = Number(rawIndex);
  const torrent = torrentPool.knownTorrent(sourceKey);
  const file = torrent?.files?.[fileIndex];
  if (!file || !(file.length > 0)) {
    return reply.code(404).send({ error: "Media file is not available." });
  }
  const rangeHeader = req.headers?.range;
  const range = mediaRange(rangeHeader, file.length);
  if (!range || range.start >= file.length) {
    reply.header("Content-Range", `bytes */${file.length}`);
    return reply.code(416).send({ error: "Invalid media byte range." });
  }
  const portion = Number(torrent.pieceLength);
  if (!Number.isSafeInteger(portion) || portion <= 0) {
    return reply.code(500).send({ error: "Source piece length is unavailable." });
  }
  if (req.method === "HEAD") {
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Length", String(file.length));
    reply.header("Content-Type", "application/octet-stream");
    return reply.send();
  }
  const missing = (start, end) => {
    onMissing({ sourceKey, fileIndex, start, end, requestId: req.query?.readId ?? req.id });
    const error = new Error(`Media bytes ${start}-${end} have not arrived.`);
    error.code = "MEDIA_BYTES_UNAVAILABLE";
    return error;
  };
  const endOfPortion = (start) => Math.min(range.end, start + portion - 1);
  const firstEnd = endOfPortion(range.start);
  const first = await torrentPool.readHeldOf(torrent, fileIndex, range.start, firstEnd);
  if (!first || first.length !== firstEnd - range.start + 1) {
    const error = missing(range.start, firstEnd);
    return reply.code(409).send({ kind: "needs-ranges", ranges: [[range.start, firstEnd]], error: error.message });
  }
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Length", String(range.end - range.start + 1));
  reply.header("Cache-Control", "no-store");
  if (rangeHeader) {
    reply.code(206);
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${file.length}`);
  }
  async function* bytes() {
    yield first;
    for (let start = firstEnd + 1; start <= range.end;) {
      if (reply.raw?.destroyed) return;
      const end = endOfPortion(start);
      const data = await torrentPool.readHeldOf(torrent, fileIndex, start, end);
      if (!data || data.length !== end - start + 1) throw missing(start, end);
      yield data;
      start = end + 1;
    }
  }
  return reply.send(Readable.from(bytes()));
}
