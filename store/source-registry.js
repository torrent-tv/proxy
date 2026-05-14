import crypto from "node:crypto";

export function createSourceRegistry(maxSources = 200) {
  const sources = new Map();

  return {
    upsert(sourceType, source) {
      const sourceKey = crypto
        .createHash("sha1")
        .update(`${sourceType}:${source}`)
        .digest("hex");

      sources.set(sourceKey, {
        sourceType,
        source,
        updatedAt: Date.now()
      });

      if (sources.size > maxSources) {
        const oldest = Array.from(sources.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        for (const [key] of oldest.slice(0, sources.size - maxSources)) {
          sources.delete(key);
        }
      }

      return sourceKey;
    },
    get(sourceKey) {
      return sources.get(sourceKey) ?? null;
    }
  };
}
