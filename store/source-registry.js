/**
 * @file In-memory registry of torrent sources.
 *
 * Sources are stored under a SHA-1 key derived from their type and content.
 * The registry is bounded: when `maxSources` is exceeded, the oldest entries
 * are evicted to keep memory usage predictable.
 */

import crypto from "node:crypto";

/**
 * @typedef {Object} SourceRecord
 * @property {"magnet" | "torrent"} sourceType - Encoding of the `source` field.
 * @property {string} source      - Magnet URI or base64-encoded .torrent bytes.
 * @property {number} updatedAt   - Unix ms timestamp of the last upsert.
 */

/**
 * Create a bounded in-memory source registry.
 *
 * @param {number} [maxSources=200] - Maximum number of entries to retain.
 * @returns {{
 *   upsert: (sourceType: string, source: string) => string,
 *   get:    (sourceKey: string) => SourceRecord | null
 * }}
 */
export function createSourceRegistry(maxSources = 200) {
  /** @type {Map<string, SourceRecord>} */
  const sources = new Map();

  return {
    /**
     * Insert or refresh a source entry and return its key.
     * Evicts the oldest entries if the map exceeds `maxSources`.
     *
     * @param {string} sourceType
     * @param {string} source
     * @returns {string} Stable SHA-1 hex key for this source.
     */
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

    /**
     * Look up a source by its key.
     * Returns `null` if the key is not registered.
     *
     * @param {string} sourceKey
     * @returns {SourceRecord | null}
     */
    get(sourceKey) {
      return sources.get(sourceKey) ?? null;
    }
  };
}
