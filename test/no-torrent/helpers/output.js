/**
 * @file The output a session serves, built the way a check needs it: on a
 * manager of its own, in that manager's catalog, addressed in its store
 * (torrent-tv/meta#309).
 *
 * The object has about twenty-five fields and was written out by hand in
 * twenty-three places. Here it is written once, with the defaults every one of
 * those copies shared; a check names only what it changes.
 */

import { mkdirSync, readdirSync } from "node:fs";
import { Output } from "../../../services/encode/output/Output.js";
import { Timeline } from "../../../services/encode/output/Timeline.js";
import { fmp4Format } from "../../../services/encode/segment-formats/fmp4.js";
import { KeyframeTable } from "../../../services/media/container/KeyframeTable.js";
import { SourceFile } from "../../../services/media/SourceFile.js";
import { outputSpec } from "./output-spec.js";

/**
 * An output on this manager: its directory in the manager's store, its entry in
 * the manager's catalog.
 *
 * @param {object} manager - From `managerWithOwnStore`.
 * @param {object} params
 * @param {string} params.id
 * @param {string} params.key - The output key; its directory is the store's.
 * @param {boolean} [params.audioOnly]
 * @param {number} [params.height] - The picture's encoded height; 0 is a copy.
 * @param {object} [overrides] - Any other field of the output, replacing its default.
 *   Pass them in `params` itself: everything but the four names above is one.
 * @returns {object} The output, as registered.
 */
export function outputOn(manager, { id, key, audioOnly = false, height = 0, ...overrides }) {
  // The output's format is the store's to know before its directory is asked for.
  const segmentFormat = { ...fmp4Format, needsSegmentRewrite: false };
  manager.segmentStore.useFormat(key, segmentFormat);
  const dirPath = manager.segmentStore.directoryFor(key);
  mkdirSync(dirPath, { recursive: true });
  const fields = {
    id,
    spec: outputSpec({ transcodeVideo: height > 0, height, audioOnly, cutGrid: "uniform" }),
    outputKey: key,
    dirPath,
    timeline: new Timeline({ boundaries: [0, 12.5, 25, 37.5, 50, 62.5], cutGrid: "uniform" }),
    state: "ready",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }).learn({ durationSeconds: 62.5 }),
    lastAloneSpeed: 2,
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    runs: new Set(),
    lastError: "",
    consumers: new Set(),
    viewers: new Map(),
    segmentCount: 5,
    // These checks serve arbitrary file bytes, which a format that rewrites what it is handed would refuse.
    segmentFormat,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    output: new Output({ encodeWidth: 0, encodeHeight: height, outputFps: 25, softwarePreset: null, applyTonemap: false }),
    keyframes: new KeyframeTable().learn({ times: [0, 12.5, 25, 37.5, 50], format: "matroska" }),
    audioOnly,
    waitEpoch: 0
  };
  // An ordinary output reads its own file, and its sound is inside it: the
  // three differ only for a soundtrack shipped as a file of its own. They follow
  // `file` unless a check names them.
  const session = {
    ...fields,
    get inputFile() { return this.file; },
    get audioFile() { return this.file; }
  };
  Object.defineProperties(session, Object.getOwnPropertyDescriptors(overrides));
  manager.outputs.set(id, session);
  return session;
}

/**
 * The segment numbers on disk now in an output's directory, ascending.
 *
 * @param {object} manager
 * @param {string} key
 * @returns {number[]}
 */
export function segmentsOnDisk(manager, key) {
  return readdirSync(manager.segmentStore.directoryFor(key))
    .map((name) => fmp4Format.segmentIndexFromName(name))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
}
