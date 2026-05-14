function buildRegistryUrl(serverUrl, pathname) {
  return new URL(pathname, ensureBaseUrl(serverUrl));
}

function ensureBaseUrl(serverUrl) {
  return serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`;
}

export async function registerClient({ serverUrl, id, name, baseUrl, token }) {
  const response = await fetch(buildRegistryUrl(serverUrl, "api/proxy-clients/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      name,
      baseUrl,
      token
    })
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Registration failed (${response.status}): ${bodyText}`);
  }

  return response.json();
}

export async function sendHeartbeat({ serverUrl, id, token }) {
  try {
    const response = await fetch(buildRegistryUrl(serverUrl, "api/proxy-clients/heartbeat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        token
      })
    });
    return response.status;
  } catch (_error) {
    return null;
  }
}
