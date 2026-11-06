/**
 * @file The torrent-pool adapters of the output graph: what the encoders and
 * the machine budget ask of the torrent thread, as plain functions.
 *
 * Moved out of the `wireOutputs` call in `server.js` verbatim
 * (torrent-tv/meta#280). It imports nothing: the pool and the registry are
 * passed in.
 */

/**
 * @param {object} ports
 * @param {object} ports.torrentPool
 * @param {{ get: (sourceKey: string) => { sourceType: string, source: unknown } | undefined }} ports.sourceRegistry
 * @param {string} ports.wholeFilesRoot - Where whole files are kept (`completedFilesRoot()`).
 */
export function torrentPoolPorts({ torrentPool, sourceRegistry, wholeFilesRoot }) {
  return {
    readEncodeRanges: async (source, ranges, maxBytes) => {
      const torrent = torrentPool.knownTorrent(source.sourceKey);
      return torrent ? torrentPool.readHeldRangesOf(torrent, source.fileIndex, ranges, maxBytes) : null;
    },
    openEncodeWholeFile: source => torrentPool.acquireWholeFile(source),
    // Which bytes of a file are downloaded whole now — what an original
    // input's stretch may extend over. A snapshot: the copy that follows
    // holds the pieces it reads, and refuses where one has gone since.
    readEncodeHeldRanges: async (source) => {
      const torrent = torrentPool.knownTorrent(source.sourceKey);
      return torrent ? torrentPool.heldRangesOf(torrent, source.fileIndex) : [];
    },
    // What the spilled pieces weigh on the torrent thread, and how to tell them
    // their share of the disk. The owner of the disk is on this side, where the
    // segments are; the pieces are on the other.
    spillDisk: typeof torrentPool.allowSpillBytes === "function"
      ? {
          held: () => torrentPool.spilledBytes ?? 0,
          allow: (bytes) => torrentPool.allowSpillBytes(bytes)
        }
      : null,
    // Files downloaded whole, kept as files. They live on the torrent thread
    // too, and until 2026-09-14 they had no bound of any kind — a 2.8 GB film
    // on a host whose disk is often a 32 GB card.
    wholeFiles: typeof torrentPool.allowWholeFileBytes === "function"
      ? {
          held: () => torrentPool.wholeFileBytes ?? 0,
          required: () => torrentPool.wholeFileRequiredBytes ?? 0,
          allow: (bytes) => torrentPool.allowWholeFileBytes(bytes),
          root: wholeFilesRoot
        }
      : null,
    // The pieces held IN memory, on the torrent thread. Told their share by the
    // same owner that divides the disk: what does not fit here is spilled
    // there, so the two cannot be divided apart.
    memoryClaimant: typeof torrentPool.allowMemoryBytes === "function"
      ? {
          held: () => torrentPool.memoryClaim?.held ?? 0,
          wanted: () => torrentPool.memoryClaim?.wanted ?? 0,
          allow: (bytes) => torrentPool.allowMemoryBytes(bytes)
        }
      : null,
    getTorrentTotals: async () => {
      if (typeof torrentPool.getTorrentTotals !== "function") {
        return null;
      }
      return torrentPool.getTorrentTotals();
    },
    setDownloadRate: (bytesPerSecond, because) => torrentPool.setDownloadRate?.(bytesPerSecond, because),
    setSpeculativeHold: (held, because) => torrentPool.setSpeculativeHold?.(held, because),
    getSourceStats: async (sourceKey, fileIndex, options) => {
      const record = sourceRegistry.get(sourceKey);
      if (!record) {
        return null;
      }
      try {
        const torrent = torrentPool.knownTorrent(sourceKey);
        if (!torrent) return null;
        // Awaited for the same reason as the stats route: this now crosses a
        // thread boundary and returns a promise.
        return await torrentPool.getFileStats(torrent, Number.isInteger(fileIndex) ? fileIndex : null, options);
      } catch {
        return null;
      }
    },
    // Pull one whole file onto the disk. Used for a soundtrack that ships beside
    // the picture, once the encoder is as far ahead of the viewer as it is
    // allowed to get — the one moment the swarm's capacity is demonstrably
    // spare. A bounded read of the file's whole length, NOT `file.select()`:
    // selecting a file alongside the readers' own windows is what made a seek
    // wait 93 s while the swarm fetched 2.47 GB in file order (see
    // `#syncSelections` in `torrent/torrent-pool.js`).
    fetchWholeFile: async ({ sourceKey, fileIndex }) => {
      const record = sourceRegistry.get(sourceKey);
      if (!record) {
        return;
      }
      const torrent = await torrentPool.getTorrent(record.sourceType, record.source);
      // The same background fill the warm-up starts when a file is chosen, not a
      // second way of doing it. It is guarded against running twice on one file,
      // so the two triggers converge instead of putting two readers on the same
      // soundtrack — and only one of them would have stood aside for the
      // picture. This trigger remains for the session that never had a warm-up
      // before it.
      await torrentPool.fillFileInBackground?.(torrent, fileIndex);
    }
  };
}
