import { parseRange } from "../../utils/parse-range.js";

function getSourceParams(query, sourceRegistry) {
  const sourceKey = typeof query.sourceKey === "string" ? query.sourceKey : "";
  const sourceTypeFromQuery = typeof query.sourceType === "string" ? query.sourceType : "";
  const sourceFromQuery = typeof query.source === "string" ? query.source : "";

  const sourceRecord = sourceKey ? sourceRegistry.get(sourceKey) : null;
  const sourceType = sourceRecord?.sourceType ?? sourceTypeFromQuery;
  const source = sourceRecord?.source ?? sourceFromQuery;
  return { sourceType, source };
}

export async function handleStreamGet(req, reply, { sourceRegistry, torrentPool }) {
  const fileIndexRaw = typeof req.query.fileIndex === "string" ? req.query.fileIndex : "";
  const fileIndex = Number(fileIndexRaw);
  const { sourceType, source } = getSourceParams(req.query, sourceRegistry);

  if (!sourceType || !source || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply
      .code(400)
      .send({ error: "sourceKey or sourceType+source with fileIndex are required." });
  }

  let torrent;
  try {
    torrent = await torrentPool.getTorrent(sourceType, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: `Failed to load torrent source: ${message}` });
  }

  const file = torrent.files[fileIndex];
  if (!file) {
    return reply.code(404).send({ error: "File index was not found in torrent." });
  }

  const releaseFile = torrentPool.acquireFile(torrent, fileIndex);

  const range = parseRange(req.headers.range, file.length);
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);

  if (!range) {
    reply.header("Content-Length", String(file.length));
    const stream = file.createReadStream();
    bindRelease(stream, reply, releaseFile);
    return reply.send(stream);
  }

  const contentLength = range.end - range.start + 1;
  reply.code(206);
  reply.header("Content-Length", String(contentLength));
  reply.header("Content-Range", `bytes ${range.start}-${range.end}/${file.length}`);
  const stream = file.createReadStream({ start: range.start, end: range.end });
  bindRelease(stream, reply, releaseFile);
  return reply.send(stream);
}

function bindRelease(stream, reply, release) {
  let released = false;
  const releaseOnce = () => {
    if (released) {
      return;
    }
    released = true;
    release();
  };

  stream.on("close", releaseOnce);
  stream.on("end", releaseOnce);
  stream.on("error", releaseOnce);
  reply.raw.once("close", releaseOnce);
  reply.raw.once("finish", releaseOnce);
}
