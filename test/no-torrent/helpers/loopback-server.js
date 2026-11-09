/**
 * @file A stand-in for the proxy's own HTTP server, listening on 127.0.0.1 at
 * a free port. It records every connection opened to it and every request it
 * read in full, so a check can tell "refused before any connection" from
 * "forwarded". It answers with whatever `respond` does; no torrent, no route.
 */

import { createServer } from "node:http";

/**
 * @typedef {{ method: string, url: string, headers: import("node:http").IncomingHttpHeaders, body: Buffer }} RecordedRequest
 */

/**
 * @param {(request: RecordedRequest, res: import("node:http").ServerResponse) => void} [respond]
 *   Called once the request body has been read. Answers 200 "ok" by default.
 * @returns {Promise<{ port: number, connections: () => number, requests: RecordedRequest[], close: () => Promise<void> }>}
 */
export async function startLoopbackServer(respond = (_request, res) => res.end("ok")) {
  /** @type {RecordedRequest[]} */
  const requests = [];
  let connections = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(recorded);
      respond(recorded, res);
    });
  });
  server.on("connection", () => { connections += 1; });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    connections: () => connections,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

/**
 * An answer that promises `declaredBytes`, sends `sentBytes` of them and then
 * drops the connection: a body that fails half-way.
 *
 * @param {number} sentBytes
 * @param {number} declaredBytes
 */
export function cutOffAfter(sentBytes, declaredBytes) {
  return (_request, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(declaredBytes) });
    res.write(Buffer.alloc(sentBytes, 7), () => {
      res.socket?.destroy();
    });
  };
}
