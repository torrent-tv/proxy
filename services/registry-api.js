/**
 * @file HTTP client for the registry server API.
 *
 * Handles proxy registration and periodic heartbeat requests.
 * The auth token is sent as the `x-proxy-token` request header.
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
 * @typedef {Object} RegisterClientParams
 * @property {string} serverUrl - Base URL of the registry server.
 * @property {string} id        - Stable unique identifier for this proxy.
 * @property {string} name      - Human-readable display name.
 * @property {string} baseUrl   - Publicly reachable base URL of this proxy.
 * @property {string} token     - Auth token sent as `x-proxy-token`.
 */

/**
 * Register this proxy with the registry server.
 * Throws if the server responds with a non-2xx status.
 *
 * @param {RegisterClientParams} params
 * @returns {Promise<{ client: { id: string, name: string, baseUrl: string, createdAt: string, lastSeenAt: string } }>}
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

/**
 * @typedef {Object} SendHeartbeatParams
 * @property {string} serverUrl - Base URL of the registry server.
 * @property {string} id        - Proxy ID to refresh.
 * @property {string} token     - Auth token sent as `x-proxy-token`.
 */

/**
 * Send a heartbeat to the registry server to refresh `lastSeenAt`.
 * Returns the HTTP status code, or `null` if the request failed entirely
 * (e.g. network error).
 *
 * @param {SendHeartbeatParams} params
 * @returns {Promise<number | null>}
 */
export async function sendHeartbeat({ serverUrl, id, token }) {
  try {
    const response = await fetch(buildRegistryUrl(serverUrl, "api/proxy-clients/heartbeat"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-proxy-token": token
      },
      body: JSON.stringify({ id })
    });
    return response.status;
  } catch (_error) {
    return null;
  }
}
