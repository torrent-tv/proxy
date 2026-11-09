/**
 * @file The one way the proxy's HTTP routes answer a byte-range request, for
 * a range read by `utils/parse-range.js`. Every answer keeps the headers set
 * by hooks (`@fastify/cors`, `Access-Control-Allow-Private-Network`).
 */

import { Readable } from "node:stream";

/**
 * Headers for a `whole` or `range` result: `Content-Length`, and
 * `Content-Range` for a range.
 *
 * @param {{ kind: "whole" } | { kind: "range", start: number, end: number }} range
 * @param {number} length - Size of the representation in bytes.
 * @returns {Record<string, string>}
 */
export function rangeHeaders(range, length) {
  if (range.kind !== "range") return { "Content-Length": String(length) };
  return {
    "Content-Length": String(range.end - range.start + 1),
    "Content-Range": `bytes ${range.start}-${range.end}/${length}`
  };
}

/**
 * Answer 416 for an unsatisfiable range, through `reply.send` so hook headers stay.
 *
 * @param {import("fastify").FastifyReply} reply
 * @param {number} length - Size of the representation in bytes.
 */
export function replyUnsatisfiable(reply, length) {
  return reply.code(416).header("Content-Range", `bytes */${length}`)
    .send({ error: "The requested byte range is not satisfiable." });
}

/**
 * Answer HEAD with 200 and `headers`, which carry the true `Content-Length`.
 *
 * The payload is an EMPTY STREAM, not nothing: for a payload of `undefined`
 * the HEAD route Fastify generates from a GET sets `content-length: 0`, and
 * the keyframe index asks for the file size with this very request and reads
 * 0 as "no index available". An explicit length is left alone for a stream.
 *
 * @param {import("fastify").FastifyReply} reply
 * @param {Record<string, string>} headers
 */
export function replyHead(reply, headers) {
  return reply.code(200).headers(headers).send(Readable.from([]));
}

/**
 * The one raw head write: the response is taken from Fastify and its head is
 * written from the headers already set on `reply` (hook headers included)
 * plus `headers`. Only for an answer whose body is written by hand, where
 * only a write callback says when a piece may be released.
 *
 * @param {import("fastify").FastifyReply} reply
 * @param {number} status
 * @param {Record<string, string>} headers
 */
export function writeRawHead(reply, status, headers) {
  // Keyed in lower case, as `getHeaders()` keys them, so that a header named
  // in both is written once, with the value given here.
  const head = { ...reply.getHeaders() };
  for (const [name, value] of Object.entries(headers)) head[name.toLowerCase()] = value;
  reply.hijack();
  reply.raw.writeHead(status, head);
}
