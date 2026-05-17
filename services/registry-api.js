/**
 * @file HTTP client for the registry server API.
 *
 * Handles proxy registration with the registry server.
 * The auth token is sent as the `x-proxy-token` request header.
 *
 * Liveness is tracked via the WebSocket tunnel connection — no heartbeat
 * HTTP polling is needed.  The proxy re-registers on every tunnel reconnect
 * so the server's in-memory store stays consistent after restarts.
 */

/**
 * Parameters required to register this proxy with the registry server.
 *
 * @typedef {Object} RegisterClientParams
 * @property {string} serverUrl - Base URL of the registry server (e.g. "http://my-server:8080").
 * @property {string} id        - Stable unique identifier for this proxy instance.
 * @property {string} name      - Human-readable display name shown in the server UI.
 * @property {string} baseUrl   - Publicly reachable base URL of this proxy's HTTP server.
 * @property {string} token     - Auth token sent as the `x-proxy-token` header.
 */

/**
 * The summary record returned by the server after a successful registration.
 *
 * @typedef {Object} ProxyClientSummary
 * @property {string} id         - Stable unique identifier.
 * @property {string} name       - Display name.
 * @property {string} baseUrl    - Advertised base URL.
 * @property {string} createdAt  - ISO timestamp of first registration.
 * @property {string} lastSeenAt - ISO timestamp of this registration.
 */

/**
 * Build a full URL to a registry API endpoint.
 *
 * @param {string} serverUrl - Base URL of the registry server.
 * @param {string} pathname  - Relative path (e.g. "api/proxy-clients/register").
 * @returns {URL}
 */
function buildRegistryUrl(serverUrl, pathname) {
  return new URL(pathname, ensureBaseUrl(serverUrl));
}

/**
 * Ensure the server URL ends with a trailing slash so that relative
 * paths in `new URL(pathname, base)` resolve correctly.
 *
 * @param {string} serverUrl
 * @returns {string}
 */
function ensureBaseUrl(serverUrl) {
  return serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`;
}

/**
 * Register this proxy with the registry server.
 *
 * Throws if the server responds with a non-2xx status.  The caller is
 * responsible for retrying — see `cli.js` → `registerWithRetry`.
 *
 * @param {RegisterClientParams} params
 * @returns {Promise<{ client: ProxyClientSummary }>}
 */
export async function registerClient({ serverUrl, id, name, baseUrl, token }) {
  const response = await fetch(buildRegistryUrl(serverUrl, "api/proxy-clients/register"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-proxy-token": token
    },
    body: JSON.stringify({ id, name, baseUrl })
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Registration failed (${response.status}): ${bodyText}`);
  }

  return response.json();
}
