/**
 * @file The download figures of a file that is held whole on disk.
 *
 * Once every file of a torrent is a file, the torrent is removed: it has
 * nothing left to fetch. The figures a viewer's page polls for still have an
 * answer, and it is known without the torrent — everything is here and nothing
 * is arriving. Asking the torrent for them instead brought it back: on
 * 2026-10-04 a film watched from its whole file was removed and added again
 * 671 times in two hours, once for every poll after each removal, and every
 * copy it left behind stayed in memory.
 */

/**
 * The same shape `TorrentPool.getFileStats` answers with, for a whole file.
 *
 * @param {number} length - Bytes in the file.
 * @returns {object}
 */
export function wholeFileStats(length) {
  const fileLength = Number.isFinite(length) && length > 0 ? length : 0;
  return {
    numPeers: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    connectedPeers: 0,
    deliveringPeers: 0,
    knownPeers: null,
    queuedPeers: null,
    trackerSeeders: null,
    trackerLeechers: null,
    trackersAnswered: 0,
    secondsToFirstPeer: null,
    secondsWaitingForFirstPeer: null,
    fileProgress: 1,
    fileDownloaded: fileLength,
    fileLength,
    fileOffset: 0,
    fileAvailable: fileLength > 0,
    residence: fileLength > 0 ? [{ start: 0, end: fileLength, location: "whole-file" }] : [],
    resumeNeededBytes: null,
    resumeDownloadedBytes: null,
    resumeAnchorByteStart: null,
    headerBytes: null,
    headerDownloadedBytes: null,
    // Nothing is delivered by a swarm, so there is no supply to describe.
    supply: null
  };
}
