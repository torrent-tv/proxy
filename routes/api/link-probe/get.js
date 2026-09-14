/**
 * @file `GET /api/link-probe?bytes=N` — bytes to measure the link with.
 *
 * WHY THIS EXISTS. A viewer's link is measured from completed transfers, and
 * the only transfers that counted were segments of the film. So the figure came
 * into being after playback had begun — after the quality offer had been made,
 * and after the start-up decisions that want it. Worse, the page's report of
 * its OWN facts was skipped when there was no figure, so at a cold open — the
 * moment where where-the-viewer-is matters most — the page said nothing at all
 * (2026-09-14).
 *
 * There is nothing to wait for: a proxy can send bytes the moment its channel
 * is up, which is when the page opens rather than when a film is chosen.
 *
 * NOT `delivery-sink`, which is the load stand's and answers any size asked
 * for. This is part of the product, always on, and bounded — the browser's own
 * sizing stops at 2 MiB and this refuses more, so a caller cannot turn it into
 * a way of drawing a proxy owner's uplink.
 *
 * The body is zeros. What is being measured is the wire, and zeros cross it at
 * the same speed as anything else; producing them costs one allocation.
 */

/**
 * The most this route will send for one ask.
 *
 * The figure is only ever used to decide what a link can carry, and the most
 * anything this product offers is a 1080p rung at around 12 Mbit/s. Two
 * mebibytes inside the browser's minimum measurable transfer (50 ms) is
 * 336 Mbit/s, twenty-eight times that rung: a link too fast to time at this
 * size is beyond anything a decision here distinguishes.
 */
export const MAX_LINK_PROBE_BYTES = 2 * 1024 * 1024;

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @returns {Promise<void>}
 */
export async function handleApiLinkProbeGet(req, reply) {
  const asked = Number(/** @type {{ bytes?: string }} */ (req.query)?.bytes);
  if (!Number.isFinite(asked) || asked <= 0) {
    return reply.code(400).send({ error: "bytes (>0) is required." });
  }
  const bytes = Math.min(Math.floor(asked), MAX_LINK_PROBE_BYTES);
  return reply
    .code(200)
    .header("Content-Type", "application/octet-stream")
    .header("Cache-Control", "no-store")
    .send(Buffer.alloc(bytes));
}
