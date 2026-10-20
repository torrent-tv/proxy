/** Record the torrent worker's verified-piece storage write without changing its callback API. */
export function tracePieceStorePut(store, trace, now = () => performance.now()) {
  const put = store?.put;
  if (typeof put !== "function") return false;

  store.put = function (index, bytes, callback) {
    const startedAt = now();
    const fields = { piece: index, bytes: bytes?.byteLength ?? bytes?.length ?? null, startedAt };
    trace("W9", "begin", fields);
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      const endedAt = now();
      trace("W9", "end", { ...fields, endedAt, durationMs: endedAt - startedAt,
        outcome: error ? "error" : "stored", ...(error ? { error: String(error?.message ?? error) } : {}) });
      callback?.(error);
    };

    try {
      return put.call(this, index, bytes, finish);
    } catch (error) {
      finish(error);
      throw error;
    }
  };
  return true;
}
