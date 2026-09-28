import { logger } from "../../utils/logger.js";
import { bandOf, waits } from "../viewer/WaitLedger.js";

const HOLD_HEADER = "x-hold-ms";
/**
 * Which viewer is asking, or an empty string where the transport names nobody.
 *
 * @param {import("fastify").FastifyRequest} req
 * @returns {string}
 */
export function consumerOf(req) {
  return typeof req.query?.consumer === "string" ? req.query.consumer : "";
}

/**
 * The generation the request says it was made in, or NaN when it says none.
 *
 * STAMPED BY THE PAGE when the request was SENT (`webrtc-hls-loader.js`), not
 * when it arrived: a request made before a seek and delivered after it still
 * says it belongs to the viewing that was left. Only a stated non-negative
 * integer counts; anything else is "nothing stated".
 *
 * @param {import("fastify").FastifyRequest} req
 * @returns {number}
 */
export function statedGenerationOf(req) {
  const raw = req.query?.generation;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return Number.NaN;
  }
  return Number(raw);
}

/**
 * Answer at once, and do nothing else, when the request belongs to a viewing
 * its viewer has left and whose window for new requests has passed.
 *
 * BEFORE ANY OTHER STEP OF THE ROUTE. Resolving a quality step or a soundtrack
 * can create an output and registers the viewer on it; a stale request that got
 * that far would leave both behind and be refused only afterwards. The answer
 * is the same one a request made pointless by a seek already gets — 503 with
 * `Retry-After: 0` — because it is the same situation seen from the other end.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ acceptsRequest: Function }} viewerRequests
 * @param {string} fileName - For the log line.
 * @returns {boolean} Whether the request was answered here.
 */
export function refusedAsStale(req, reply, viewerRequests, fileName) {
  const consumerId = consumerOf(req);
  const stated = statedGenerationOf(req);
  if (viewerRequests.acceptsRequest(consumerId, stated)) {
    return false;
  }
  logger.info(
    `[hold] ${fileName} refused: made in generation ${stated} of ${consumerId}, ` +
    `a viewing they have left and whose window for new requests has passed`
  );
  reply.header("Retry-After", "0");
  reply.code(503).send({ error: "Made for a viewing that has been left." });
  return true;
}

/**
 * Serve one playlist or segment from a named session.
 *
 * Split from the route above because the variant route
 * (`/transcode/:sessionId/v/:height/:fileName`) serves the same files from
 * another session of the same family, and must hold, log and answer them
 * identically — a switch of quality must not go through a different code path
 * from the stream it switches away from.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ serving: object, viewerRequests: object, sessionId: string, fileName: string }} params
 * @returns {Promise<void>}
 */
export async function serveSessionFile(req, reply, { serving, viewerRequests, sessionId, fileName }) {
  // Which viewer is asking. One session serves everyone watching a copied
  // picture, so without it their positions collapse into one and a seek by the
  // viewer in front releases the requests held for the viewer behind. Absent on
  // a plain HTTP transport, where no loader of ours builds the URL, and then
  // the single shared position decides as it always did.
  const consumerId = consumerOf(req);
  // Hold the request only briefly, then answer "retry" instead of waiting for
  // the segment. iOS's native HLS player (AVPlayer) enforces a hard ~3.5 s
  // deadline on RESPONSE HEADERS and raises -12889 ("No response for media
  // file") when it passes — it then cancels in-flight requests, probes
  // neighbouring positions and can restart the stream from the beginning. That
  // is exactly the post-seek "player thrashing" seen in the field, because a
  // seek restarts ffmpeg and the first segment then takes far longer than 3.5 s
  // to appear. Holding the connection for 30 s (as this did) guaranteed the
  // timeout on every seek. A short hold keeps the fast path intact (a ready or
  // nearly-ready segment is still served on the first request) while a slow one
  // gets a prompt retryable answer, which resets the player's own deadline.
  // hls.js is unaffected: it consumes the 503 through its retry policy, whose
  // budget the client widens to match (see hls-player.js fragLoadPolicy).
  // Instrumented wait. `clientAborted` flips when the player drops the
  // connection while we are still holding it — the single most informative
  // signal about its real patience, and observable only from this side.
  const holdStartedAt = Date.now();
  let clientAborted = false;
  let onClientAbort = () => {};
  const clientGone = new Promise((resolve) => {
    onClientAbort = () => {
      clientAborted = true;
      resolve();
    };
  });
  req.raw.on("close", onClientAbort);
  const statedHoldMs = Number(req.headers?.[HOLD_HEADER]);

  const result = await waitForSessionFile(serving, sessionId, fileName, {
    holdMs: Number.isFinite(statedHoldMs) && statedHoldMs > 0 ? statedHoldMs : Number.POSITIVE_INFINITY,
    until: clientGone,
    consumerId
  });

  req.raw.off("close", onClientAbort);
  const heldMs = Date.now() - holdStartedAt;
  if (result.isPlaylist !== true) {
    const outcome = clientAborted
      ? "client-aborted"
      : result.kind === "ok" ? "served" : result.kind;
    // AGAINST THE RANK THE MAP GAVE IT. A wait is the only thing that says
    // whether the prioritisation is being used well, and this is the one place
    // in the proxy where a viewer is measurably waiting for a named segment.
    // Recorded even when the segment was served at once: a run of short waits
    // at the top rank is what "the urgent zone is being served first" looks
    // like, and without them the table would hold only the failures.
    const ranked = result.ranked ?? null;
    if (ranked) {
      waits.note(ranked.address, heldMs, ranked.rank, ranked.topRank);
    }
    logger.info(
      `[hold] ${fileName} ${outcome} after ${heldMs}ms` +
      (ranked ? ` (the map wants it ${bandOf(ranked.rank, ranked.topRank)}, rank ${ranked.rank} of ${ranked.topRank})` : "")
    );
  }

  if (result.kind === "not-found") {
    return reply.code(404).send({ error: "Transcode session file was not found." });
  }
  if (result.kind === "superseded") {
    // The viewer moved while this was being held, and this segment is not the
    // one they moved TO — that case is kept and waited out, see
    // `waitForSessionFile`. Answer at once so the player can ask for where it
    // is now; `Retry-After: 0` because there is nothing to wait for.
    //
    // Named in the log, because a refusal that says only "superseded" is what
    // made the 2026-08-18 freeze take a day to explain: the player was refused
    // the segment at its own seek target and nothing recorded which segment or
    // where the viewer was.
    logger.info(
      `[hold] ${fileName} refused: the viewer is at ` +
      `${viewerRequests.viewerPositionOf(sessionId, consumerId).toFixed(1)}s and this is not the segment there`
    );
    reply.header("Retry-After", "0");
    return reply.code(503).send({ error: "Superseded by a seek." });
  }
  if (result.kind === "warming-up") {
    // The segment is still being produced (e.g. just after a seek-restart).
    // Return a retryable 503 — never 202, which hls.js cannot consume as a
    // media segment — so the player retries the fetch shortly.
    reply.header("Retry-After", "1");
    // `Retry-After` tells the player to re-request THIS segment after a short
    // pause. Without it a bare 503 reads as "nothing here", and the player goes
    // looking elsewhere: because our synthetic VOD playlist lists every segment
    // of the file, it believes they all exist and SCANS them (field log: one
    // user seek produced probes at #617, #717, #732…). That scan is what used
    // to steer the encoder off the real target. Whether iOS's native player
    // honours the hint is not guaranteed — its behaviour is closed — but this
    // is the standard, correct way to say "wait, don't look elsewhere", and
    // hls.js already retries the same fragment regardless.
    reply.header("Retry-After", "1");
    // SAY WHY, to the viewer and not only to the log. The same refusal is
    // written into `proxy.log` with the rank the priority map gave this
    // segment; the page had no access to that and told the viewer it did not
    // know why. Field 2026-09-14: `rank 1 of 100` — nothing was making it —
    // printed sixty seconds before the page gave up saying the opposite.
    return reply.code(503).send({
      error: "Transcode segment is still being produced.",
      reason: warmingReason(result.ranked ?? null)
    });
  }
  if (result.kind === "failed") {
    return reply.code(500).send({ error: result.message });
  }

  if (result.isPlaylist) {
    reply.header("Cache-Control", "no-store");
  } else {
    reply.header("Cache-Control", "public, max-age=60");
    holdWhileSending(reply, result.stream, viewerRequests.holdResponse(sessionId, consumerId));
  }
  reply.header("Content-Type", result.contentType);
  return reply.send(result.stream);
}

/**
 * Keep the output this response comes from held until the response is over.
 *
 * Over means any of `finish`, `close` or `error` of the response, or `error`
 * of the stream being sent — whichever comes first, and usually more than one
 * of them comes: a response that finishes also closes. `release` is safe to
 * call any number of times, which is what makes listening to all of them
 * correct rather than a leak or a double release.
 *
 * A response already over before it began (the requester went during the
 * hold) is released at once: none of its events will fire again.
 *
 * @param {import("fastify").FastifyReply} reply
 * @param {import("node:stream").Readable | undefined} stream
 * @param {() => void} release
 * @returns {void}
 */
function holdWhileSending(reply, stream, release) {
  const response = reply.raw;
  if (!response || response.destroyed || response.writableEnded) {
    release();
    return;
  }
  response.once("finish", release);
  response.once("close", release);
  response.once("error", release);
  stream?.once?.("error", release);
}

/**
 * Ask `serving.getFileStream()` again each time the file may have become
 * available — a segment's publication, or a waited-on invalidation — until it
 * is, the session fails, the requester's stated wait runs out, or the
 * requester goes.
 *
 * @param {object} serving - `services/server/SegmentServing.js`
 * @param {string} sessionId
 * @param {string} fileName
 * @param {object} hold
 * @param {number} hold.holdMs - How long the requester will wait; may be
 *   infinite when it stated nothing.
 * @param {Promise<void>} [hold.until] - Settles when the requester has gone.
 * @param {string} [hold.consumerId] - Which viewer is asking, where the
 *   transport carries it. Their own position is what decides whether a held
 *   request has been made pointless by a seek — a session can have several
 *   viewers, and the seek epoch belongs to all of them.
 * @returns {Promise<Awaited<ReturnType<import("./SegmentServing.js").SegmentServing["getFileStream"]>>>}
 */
export async function waitForSessionFile(serving, sessionId, fileName, { holdMs, until = null, consumerId = "" }) {
  const startedAt = Date.now();
  let gone = false;
  const requesterGone = until ? until.then(() => { gone = true; }) : new Promise(() => {});
  // The viewer's position when this request was made. A seek makes every held
  // request stale — it asks for a segment nobody is going to watch — and hls.js
  // keeps only ONE fragment load outstanding, so holding on blocks the request
  // the player actually needs now. Measured: 57 s of a 58 s backward seek was
  // this wait, and the segment the viewer wanted took 15 ms once it was asked
  // for.
  let seekEpoch = serving.seekEpoch(sessionId);
  /** @type {{ address: string, rank: number, topRank: number } | null} */
  let lastRanked = null;
  while (!gone && Date.now() - startedAt < holdMs) {
    const result = await serving.getFileStream(sessionId, fileName, { consumerId });
    if (result.kind !== "warming-up") {
      return result;
    }
    if (serving.seekEpoch(sessionId) !== seekEpoch) {
      // A seek moved the epoch. Whether THIS request is stale depends on which
      // segment it asks for: the one the viewer has just landed on races the
      // seek notification and would otherwise be refused at the exact moment it
      // is needed — measured 2026-08-18, two 503s within 80 ms on the segment
      // at the seek target, after which the player never asked for it again.
      if (!serving.requestStillWanted(sessionId, fileName, consumerId)) {
        return { kind: "superseded" };
      }
      logger.info(
        `[hold] ${fileName} kept across a seek: it is the segment the viewer now needs`
      );
      seekEpoch = serving.seekEpoch(sessionId);
    }
    // The rank the map last gave this segment, so a request that runs out of
    // patience is still counted against what it was promised. Kept across the
    // polls because the timeout path has no result of its own.
    lastRanked = result.ranked ?? lastRanked;
    const remaining = Math.max(0, holdMs - (Date.now() - startedAt));
    const waitedForSegment = await serving.waitForSegment(sessionId, fileName, remaining, until);
    if (!waitedForSegment && !gone) {
      // Playlists and init files are not segment publications.
      await Promise.race([delay(Math.min(300, remaining)), requesterGone]);
    }
  }
  return { kind: "warming-up", ranked: lastRanked };
}

/**
 * Resolve after a given number of milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * What to tell the VIEWER when a segment is not there yet.
 *
 * In their terms — the film, and what is being done about it — never in ours: a
 * viewer cannot read a log, does not know what a rank is, and is not helped by
 * being told which of our parts is waiting for which other.
 *
 * @param {{ rank: number, topRank: number } | null} ranked - What the priority
 *   map thought of this segment while the request was held.
 * @returns {string}
 */
function warmingReason(ranked) {
  if (ranked && ranked.rank < ranked.topRank) {
    // The map is working somewhere else in the film. That is the answer the
    // failure of 2026-09-14 needed and nobody was given.
    return "This part of the film is not being prepared yet — the proxy is working further along.";
  }
  return "This part of the film is still being prepared.";
}
