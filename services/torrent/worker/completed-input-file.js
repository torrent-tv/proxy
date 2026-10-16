import { open } from "node:fs/promises";
import { Readable } from "node:stream";

/** Open one pinned completed file; every HTTP response owns a separate read. */
export async function openCompletedInputFile(file, release) {
  let handle;
  try {
    handle = await open(file.path, "r");
    if ((await handle.stat()).size !== file.length) throw new Error("Completed file length changed.");
  } catch {
    await handle?.close();
    await release();
    return null;
  }
  let references = 1, released = false, closing = false;
  let finish;
  const closed = new Promise(resolve => { finish = resolve; });
  const drop = () => {
    references--;
    if (references || closing) return;
    closing = true;
    void handle.close().finally(release).then(() => finish(), error => finish(error));
  };
  return {
    length: file.length, closed,
    stream(start, end, onRead) {
      if (released || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= file.length) return null;
      references++;
      let dropped = false;
      const done = () => { if (!dropped) { dropped = true; drop(); } };
      const stream = Readable.from((async function* () {
        for (let at = start; at <= end;) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - at + 1));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
          if (!bytesRead) throw new Error("Completed file ended inside an admitted range.");
          at += bytesRead;
          onRead(bytesRead);
          yield buffer.subarray(0, bytesRead);
        }
      })(), { objectMode: false, highWaterMark: 64 * 1024 });
      stream.once("end", done);
      stream.once("close", done);
      return stream;
    },
    release() {
      if (!released) { released = true; drop(); }
      return closed;
    }
  };
}
