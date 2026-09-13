/**
 * @file Take the browser's own log and keep it beside the proxy's.
 *
 * The page has always forwarded its console somewhere; until now that was the
 * SERVER's standard output on the droplet, which every release destroys. Both
 * halves of a failure are needed to explain one — what the proxy did and what
 * the page saw — and on 2026-09-13 an investigation ran on half of them for
 * exactly that reason.
 *
 * Here the two land in one directory, on the host's durable disk, in files
 * named so they join without guessing.
 *
 * The server's route stays and is not replaced: a page that has no proxy yet,
 * or whose connection to one just failed, still has something to say, and those
 * are the moments that matter most.
 */

const MAX_LINES = 50;
const MAX_MSG_LEN = 2000;
const MAX_TAG_LEN = 40;
const MAX_SID_LEN = 16;
const MAX_NAME_LEN = 200;

/**
 * @param {unknown} value
 * @param {number} maxLen
 * @returns {string}
 */
function safeString(value, maxLen) {
  return (typeof value === "string" ? value : "").slice(0, maxLen);
}

/**
 * Replace every control character with a space.
 *
 * These lines are written by a stranger's browser into a file a person will
 * later read in a terminal: a newline would forge a log entry and an escape
 * sequence would drive the terminal.
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeLine(value) {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : character;
  }
  return out;
}

/**
 * `POST /api/client-logs`
 *
 * Body: `{ sessionId, startedAt, torrentName, infoHash, tag, signalSessionId,
 * lines: [{ level, ts, msg }] }`.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientLogs: { write: (session: object, lines: string[]) => void } | null }} deps
 * @returns {Promise<unknown>}
 */
export async function handleApiClientLogsPost(req, reply, { clientLogs }) {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const session = {
    sessionId: safeString(body.sessionId, MAX_SID_LEN) || "unknown",
    startedAt: safeString(body.startedAt, 30),
    torrentName: sanitizeLine(safeString(body.torrentName, MAX_NAME_LEN)),
    infoHash: safeString(body.infoHash, 40)
  };
  const tag = sanitizeLine(safeString(body.tag, MAX_TAG_LEN)) || "Unknown/Unknown";
  const rows = Array.isArray(body.lines) ? body.lines.slice(0, MAX_LINES) : [];

  const lines = rows.map((row) => {
    const entry = row && typeof row === "object" ? row : {};
    const level = safeString(entry.level, 8) || "log";
    const at = sanitizeLine(safeString(entry.ts, 16));
    const message = sanitizeLine(safeString(entry.msg, MAX_MSG_LEN));
    return `[${tag}] ${at} ${level}: ${message}`;
  });

  if (lines.length > 0) {
    clientLogs?.write(session, lines);
  }
  return reply.code(204).send();
}
