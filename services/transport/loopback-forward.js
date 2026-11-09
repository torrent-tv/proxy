/**
 * @file The one place a relayed request becomes an HTTP call to the proxy's own
 * Fastify server on 127.0.0.1.
 *
 * Every forwarded request arrives at the local server from the loopback
 * address, so routes that trust loopback callers (`/encode-input/*`, `/media`)
 * would accept it. The path allowlist and the body cap here keep a relayed
 * request to the routes the browser uses and to a bounded size, and both are
 * checked before any connection is opened.
 */

import { Agent } from "undici";

/** Max size of a forwarded request body, in bytes (32 MiB). */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/**
 * The routes the browser uses: /api/*, /stream, /transcode/*, /health, /healthz.
 * See docs/browser-proxy-contract.md.
 */
const PATH_ALLOWLIST_RE = /^(?:\/api\/|\/stream(?:$|\?)|\/?transcode\/|\/health(?:z)?(?:$|\?))/;

// Route availability and caller cancellation determine media request lifetime:
// a held segment request waits for ffmpeg as long as the route says, so undici
// must not cut it off with its default 300 s header or body timeout.
const loopbackDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/**
 * True when `path` is an absolute, traversal-free path on a browser route.
 *
 * @param {unknown} path
 * @returns {boolean}
 */
export function isValidRequestPath(path) {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.includes("..") &&
    PATH_ALLOWLIST_RE.test(path)
  );
}

/** Thrown before any connection is opened when a request is refused. */
export class LoopbackRefusal extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "LoopbackRefusal";
  }
}

/**
 * Forward one relayed request to the local proxy server.
 *
 * @param {object} request
 * @param {number} request.port        local Fastify port
 * @param {string} request.requestId   sent as x-ttv-forwarded-request-id
 * @param {string} request.method
 * @param {string} request.path
 * @param {string} [request.query]     without the leading "?"
 * @param {Record<string, string>} [request.headers]
 * @param {string | Buffer | null} [request.body]
 * @param {AbortSignal} request.signal
 * @returns {Promise<Response>}        the undici fetch Response, unread
 */
export async function forwardToLoopback({ port, requestId, method, path, query, headers, body, signal }) {
  if (!isValidRequestPath(path)) throw new LoopbackRefusal("Invalid request path.");
  if (body != null && Buffer.byteLength(body) > MAX_REQUEST_BODY_BYTES) {
    throw new LoopbackRefusal("Request body too large.");
  }
  return fetch(`http://127.0.0.1:${port}${path}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      ...(headers ?? {}),
      host: `127.0.0.1:${port}`,
      "x-ttv-forwarded-request-id": requestId
    },
    body: body != null ? body : undefined,
    redirect: "manual",
    dispatcher: loopbackDispatcher,
    signal
  });
}
