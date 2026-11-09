import { Readable } from "node:stream";
import { parseRange } from "../../utils/parse-range.js";
import { rangeHeaders, replyHead, replyUnsatisfiable } from "../../services/server/byte-range-reply.js";

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
  const portion = Number(torrent.pieceLength);
  if (!Number.isSafeInteger(portion) || portion <= 0) {
    return reply.code(500).send({ error: "Source piece length is unavailable." });
  }
  if (req.method === "HEAD") {
    return replyHead(reply, {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.length)
    });
  }
  // Range applies to GET only (RFC 9110 §14.2): HEAD answered above ignores it.
  const parsed = parseRange(req.headers?.range, file.length);
  if (parsed.kind === "unsatisfiable") return replyUnsatisfiable(reply, file.length);
  const range = parsed.kind === "range" ? parsed : { start: 0, end: file.length - 1 };
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
  reply.header("Cache-Control", "no-store");
  reply.code(parsed.kind === "range" ? 206 : 200);
  reply.headers(rangeHeaders(parsed, file.length));
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
