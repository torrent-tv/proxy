import { parseRange } from "../../utils/parse-range.js";

/** FFmpeg reads only original byte ranges already owned by its live run. */
export function handleEncodeInputGet(req, reply, { inputOf, refused = () => {} }) {
  const address = req.raw?.socket?.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) return reply.code(403).send();
  const token = Number(req.params.token), fileIndex = Number(req.params.fileIndex);
  if (!Number.isSafeInteger(token) || !Number.isSafeInteger(fileIndex) || fileIndex < 0) return reply.code(400).send();
  const input = inputOf(token);
  const length = input?.lengthOf(fileIndex);
  if (!Number.isSafeInteger(length) || length <= 0) return reply.code(404).send();
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", "application/octet-stream");
  if (req.method === "HEAD") {
    reply.hijack();
    reply.raw.writeHead(200, { "Accept-Ranges": "bytes", "Content-Type": "application/octet-stream", "Content-Length": String(length) });
    reply.raw.end();
    return;
  }
  const range = parseRange(req.headers.range, length);
  if (!range || range.start >= length) return reply.code(416).header("Content-Range", `bytes */${length}`).send();
  // The answer runs to the end of the admitted range the read starts in, which
  // is what keeps FFmpeg inside the bytes the run holds. A shorter answer is
  // not continued by every FFmpeg: measured, 8.1.2 and 9.0.2 send a new
  // request, while 5.1, 6.1, 7.0.2 (ffmpeg-static on Linux), 7.1 and 8.0 take
  // it for a read error. A cap of 1 MiB here ended every original-source
  // segment longer than that on 6.1 (torrent-tv/meta#151). The end of an
  // admitted range is therefore only reached where FFmpeg needs nothing more,
  // and a byte past it is refused, which from 7.1 on ends the run: every read
  // FFmpeg makes, its stream search at open included, must be named by the
  // container (torrent-tv/meta#165).
  const held = input.read(fileIndex, range.start, range.end, true);
  if (!held) {
    // FFmpeg asked for a byte the run was not given: the container named too
    // little. Said, because FFmpeg itself reports only a failed seek or read.
    refused({ token, fileIndex, start: range.start, runTag: input.runTag ?? null });
    return reply.code(503).send({ error: "Original input bytes are outside the admitted ranges." });
  }
  return reply.code(206).header("Content-Length", String(held.bytes.length))
    .header("Content-Range", `bytes ${range.start}-${held.end}/${length}`).send(held.bytes);
}
