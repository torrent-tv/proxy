/**
 * @file Playback controller — interface layer over playback planning.
 *
 * Thin adapter between HTTP/routes and the application orchestrators.
 * Does not parse containers itself — delegates to containerOrchestrator and
 * the existing playback-planner service. Exists so routes depend on a
 * controller contract, not on service internals.
 */

import { containerOrchestrator } from "../orchestrators/ContainerOrchestrator.js";

export class PlaybackController {
  /**
   * @param {object} deps
   * @param {import("../torrent-pool.js").TorrentPool} deps.torrentPool
   * @param {ReturnType<import("../../store/source-registry.js").createSourceRegistry>} deps.sourceRegistry
   * @param {string} deps.ffmpegBin
   * @param {string} deps.localBaseUrl
   * @param {ReturnType<import("../playback-planner.js").createPlaybackPlanner>} deps.playbackPlanner
   */
  constructor({ torrentPool, sourceRegistry, ffmpegBin, localBaseUrl, playbackPlanner }) {
    this.torrentPool = torrentPool;
    this.sourceRegistry = sourceRegistry;
    this.ffmpegBin = ffmpegBin;
    this.localBaseUrl = localBaseUrl;
    this.playbackPlanner = playbackPlanner;
    this.containers = containerOrchestrator;
  }

  async getPlan(params) {
    return this.playbackPlanner.getPlan(params);
  }
}
