import { parseRange } from "../../utils/parse-range.js";
import { Readable } from "node:stream";

/** FFmpeg reads only original byte ranges already owned by its live run. */
export async function handleEncodeInputGet(req, reply, { inputOf, refused = () => {} }) {
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
  // A read inside the stretch of film waits for its copy, which goes on while
  // FFmpeg opens (`OriginalInput.js`); the answer is then whole, as any other.
  const held = await input.read(fileIndex, range.start, range.end, true);
  if (!held && input.copyFailed?.()) {
    // The copy of the stretch failed: a piece left the store between the
    // check that it was there and the copy. The run ends on this refusal, and
    // the failure is said where the copy is accounted for (`EncodeInputs.js`).
    return reply.code(503).send({ error: "Original input bytes could not be copied." });
  }
  if (!held) {
    // FFmpeg asked for a byte the run was not given: the container named too
    // little. Said, because FFmpeg itself reports only a failed seek or read.
    refused({ token, fileIndex, start: range.start, runTag: input.runTag ?? null });
    return reply.code(503).send({ error: "Original input bytes are outside the admitted ranges." });
  }
  // A deferred read may finish after FFmpeg closed the connection. No close
  // event remains to release an answer acquired after that event.
  if (reply.raw?.destroyed || req.raw?.aborted) {
    held.stream?.destroy();
    held.release?.();
    return reply;
  }
  const body = held.stream ?? (held.chunks ? Readable.from(held.chunks, { objectMode: false }) : held.bytes);
  // What was handed to the system for this answer before its connection
  // closed, and whether all of it was: an answer runs to the end of its
  // admitted range and FFmpeg closes the connection once it has what it wants,
  // so the range answered says nothing about the bytes taken. What FFmpeg read
  // is at most what was handed over; the kernel's buffer is the difference,
  // and it cannot be seen from here (torrent-tv/meta#177).
  const socket = req.raw?.socket;
  const writtenBefore = socket?.bytesWritten ?? 0;
  reply.raw?.once?.("close", () => {
    body?.destroy?.();
    held.release?.();
    input.noteAnswer?.({ fileIndex, start: range.start, end: held.end,
      written: Math.max(0, (socket?.bytesWritten ?? writtenBefore) - writtenBefore),
      handedOver: reply.raw?.writableFinished === true });
  });
  try {
    return reply.code(206).header("Content-Length", String(held.size ?? held.bytes.length))
      .header("Content-Range", `bytes ${range.start}-${held.end}/${length}`).send(body);
  } catch (error) {
    body?.destroy?.();
    held.release?.();
    throw error;
  }
}
