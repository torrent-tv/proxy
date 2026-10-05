/**
 * @file Which files and sources are held whole on disk, asked by the torrent
 * thread before it brings a torrent back.
 *
 * A torrent whose every file is a file has nothing to fetch, so it is removed;
 * anything that names the source again rebuilt it from its recipe. That is
 * right for a read the files cannot answer, and it was wrong for everything
 * else. The page polls the download figures and the viewers state a priority
 * map for as long as the film plays, and each of those rebuilt the torrent
 * only to be told nothing was missing; ten seconds later the sweep removed it
 * again. Field 2026-10-04: 671 removals in two hours of one viewer watching one
 * whole file, and every copy left behind in memory.
 *
 * So the rule is stated once, here: a file held whole does not bring its
 * torrent back to be steered or measured, and a source held whole is described
 * by what was written down when its torrent went. The torrent is used if it
 * exists.
 */

/**
 * What the torrent thread says about a source when it is opened.
 *
 * @typedef {object} SourceDescription
 * @property {string} infoHash
 * @property {string} name
 * @property {number} pieceLength
 * @property {{ index: number, name: string, path: string, length: number }[]} files
 */

/**
 * @param {object} params
 * @param {(infoHash: string, fileIndex: number) => ({ length: number } | null)} params.find
 *   The whole file kept for this infohash and index, or null.
 * @returns {{
 *   fileOf: (sourceKey: string, fileIndex: number) => ({ length: number } | null),
 *   remember: (sourceKey: string, description: SourceDescription) => void,
 *   isWhole: (sourceKey: string) => boolean,
 *   describe: (sourceKey: string) => (SourceDescription | null)
 * }}
 */
export function createWholeSources({ find }) {
  /** @type {Map<string, SourceDescription>} */
  const descriptions = new Map();

  const infoHashOf = (sourceKey) => {
    const key = String(sourceKey ?? "");
    return key.startsWith("torrent:") ? key.slice("torrent:".length).toLowerCase() : null;
  };

  const fileOf = (sourceKey, fileIndex) => {
    const infoHash = infoHashOf(sourceKey);
    if (infoHash === null || !Number.isInteger(fileIndex) || fileIndex < 0) {
      return null;
    }
    return find(infoHash, fileIndex) ?? null;
  };

  // Asked again each time rather than remembered as a verdict: a whole file can
  // be removed for space, and then the torrent has work again.
  const isWhole = (sourceKey) => {
    const files = descriptions.get(String(sourceKey))?.files ?? [];
    return files.length > 0 && files.every((file) => fileOf(sourceKey, file.index) !== null);
  };

  return {
    fileOf,
    remember(sourceKey, description) {
      if (infoHashOf(sourceKey) !== null && Array.isArray(description?.files) && description.files.length > 0) {
        descriptions.set(String(sourceKey), description);
      }
    },
    isWhole,
    describe(sourceKey) {
      return isWhole(sourceKey) ? descriptions.get(String(sourceKey)) : null;
    }
  };
}
