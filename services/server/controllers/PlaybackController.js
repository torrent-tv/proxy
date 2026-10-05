/**
 * @file Playback controller — interface layer over playback planning.
 *
 * Thin adapter between HTTP/routes and the playback plan. Parses nothing
 * itself. Exists so routes depend on a controller contract, not on service
 * internals.
 *
 * It used to hold a `ContainerOrchestrator` as well, and that was the main
 * thread's own instance of a module singleton the torrent worker also loads —
 * so it held no container, was asked nothing, and made it look as though a
 * container could be consulted here. It cannot: the file's bytes are in the
 * worker, and an object with methods does not cross a thread. What crosses is a
 * message.
 */

export class PlaybackController {
  /**
   * @param {object} deps
   * @param {import("../../torrent/torrent-pool.js").TorrentPool} deps.torrentPool
   * @param {ReturnType<import("../../../store/source-registry.js").createSourceRegistry>} deps.sourceRegistry
   * @param {string} deps.ffmpegBin
   * @param {string} deps.localBaseUrl
   * @param {ReturnType<import("../../media/playback-planner.js").createPlaybackPlanner>} deps.playbackPlanner
   */
  constructor({ torrentPool, sourceRegistry, ffmpegBin, localBaseUrl, playbackPlanner }) {
    this.torrentPool = torrentPool;
    this.sourceRegistry = sourceRegistry;
    this.ffmpegBin = ffmpegBin;
    this.localBaseUrl = localBaseUrl;
    this.playbackPlanner = playbackPlanner;
  }

  async getPlan(params) {
    return this.playbackPlanner.getPlan(params);
  }

  async getReadyPlan(params, options) {
    return this.playbackPlanner.getReadyPlan(params, options);
  }

  async refreshAudioTracks(params) {
    return this.playbackPlanner.refreshAudioTracks(params);
  }
}
