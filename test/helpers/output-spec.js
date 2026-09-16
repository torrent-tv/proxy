import { AudioOutput, CutGrid, OutputSpec, VideoOutput } from "../../services/output/OutputSpec.js";

/**
 * Build the output identity used by production objects in focused tests.
 *
 * @param {object} [params]
 * @param {string} [params.sourceKey]
 * @param {number} [params.fileIndex]
 * @param {boolean} [params.transcodeVideo]
 * @param {boolean} [params.transcodeAudio]
 * @param {boolean} [params.audioOnly]
 * @param {boolean} [params.audioSeparate]
 * @param {number} [params.audioFileIndex]
 * @param {number} [params.audioSourceTrackIndex]
 * @param {number} [params.width]
 * @param {number} [params.height]
 * @param {string} [params.encoder]
 * @param {number} [params.fps]
 * @param {string | null} [params.preset]
 * @param {boolean} [params.tonemap]
 * @param {"keyframe" | "uniform"} [params.cutGrid]
 * @param {string} [params.segmentFormatId]
 * @returns {OutputSpec}
 */
export function outputSpec({
  sourceKey = "source-1",
  fileIndex = 0,
  transcodeVideo = false,
  transcodeAudio = true,
  audioOnly = false,
  audioSeparate = false,
  audioFileIndex = fileIndex,
  audioSourceTrackIndex = 0,
  width = 0,
  height = 0,
  encoder = "libx264",
  fps = 24,
  preset = null,
  tonemap = false,
  cutGrid = "uniform",
  segmentFormatId = "fmp4"
} = {}) {
  return new OutputSpec({
    sourceKey,
    segmentFormatId,
    grid: new CutGrid({ kind: cutGrid, fileIndex }),
    video: audioOnly
      ? null
      : new VideoOutput({
          fileIndex,
          encode: transcodeVideo ? { encoder, width, height, fps, preset, tonemap } : null
        }),
    audio: audioSeparate
      ? null
      : new AudioOutput({
          fileIndex: audioFileIndex,
          trackIndex: audioSourceTrackIndex,
          transcode: transcodeAudio
        })
  });
}
