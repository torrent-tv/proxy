/**
 * A stream of bytes with no torrent behind it, for measuring delivery alone.
 *
 * GET /api/delivery-sink?bytes=8388608
 *
 * The delivery freeze (roadmap item 11) takes hundreds of megabytes to appear
 * and needs the real transport to appear at all, so reproducing it means
 * pushing gigabytes through a data channel on demand. Doing that through a real
 * file drags in the swarm, the encoder and the disk, none of which is under
 * test and each of which has its own stalls; this route removes them and leaves
 * the path the question is about: the same handler, the same chunk loop, the
 * same backpressure, the same channel.
 *
 * The body is a repeating pattern rather than zeroes, so a receiver can verify
 * it got the bytes it was promised in the order they were sent — a silent
 * truncation would otherwise read as a successful transfer.
 *
 * Enabled only when the proxy was started with `--delivery-sink`; without the
 * flag the route answers 404, so an ordinary install has no such endpoint.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ enabled: boolean }} deps
 * @returns {Promise<void>}
 */
export async function handleApiDeliverySinkGet(req, reply, { enabled } = {}) {
  if (enabled !== true) {
    return reply.code(404).send({ error: "Not found." });
  }

  const requested = Number((req.query ?? {}).bytes);
  const total = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 0), MAX_SINK_BYTES)
    : DEFAULT_SINK_BYTES;

  // One buffer, reused: allocating a fresh chunk per iteration would make this
  // route measure the allocator as much as the transport.
  const chunk = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < CHUNK_BYTES; i += 1) {
    chunk[i] = i % 251; // 251 is prime, so the pattern does not align to any power of two.
  }

  reply.header("content-type", "application/octet-stream");
  reply.header("content-length", String(total));
  reply.header("cache-control", "no-store");

  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK_BYTES, total - sent);
      controller.enqueue(size === CHUNK_BYTES ? chunk : chunk.subarray(0, size));
      sent += size;
    }
  });

  return reply.send(stream);
}

/** Chunk size, matching what a body read hands the send loop for a real file. */
const CHUNK_BYTES = 64 * 1024;
/** Default when no size is asked for: about one segment of 1080p. */
const DEFAULT_SINK_BYTES = 8 * 1024 * 1024;
/** Ceiling, so one request cannot ask the proxy for an unbounded stream. */
const MAX_SINK_BYTES = 64 * 1024 * 1024;
