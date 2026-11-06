/**
 * @file What this host does, measured once at startup before any viewer
 * exists: the encoder, what decoding and a second job cost, the calibrated
 * modes, the copy speed, audio, a start and a stop, and tone-mapping.
 *
 * Moved out of `server.js` verbatim (torrent-tv/meta#280): the same awaits in
 * the same order. `measures` defaults to the real functions; a test passes
 * fakes so that no ffmpeg runs.
 */

import {
  detectVideoEncoder,
  benchmarkDecodeCost,
  benchmarkContention,
  benchmarkCopySpeed,
  detectTonemapSupport,
  softwareDescriptor
} from "./hwaccel.js";
import { calibrateEncoder, HostCalibration } from "./calibration.js";
import { readHostFingerprint } from "./fingerprint.js";
import { measureStartAndStop } from "./start-stop-cost.js";
import { benchmarkAudio } from "./audio-calibration.js";

const DEFAULT_MEASURES = {
  detectVideoEncoder,
  benchmarkDecodeCost,
  benchmarkContention,
  readHostFingerprint,
  calibrateEncoder,
  softwareDescriptor,
  benchmarkCopySpeed,
  benchmarkAudio,
  measureStartAndStop,
  detectTonemapSupport
};

/**
 * @param {object} params
 * @param {string} params.ffmpegBin
 * @param {{ info: Function, warn: Function }} params.logger
 * @param {boolean} params.transcode - Whether transcoding can occur; false measures nothing.
 * @param {number} params.processorCores - The cores this process may use (a container's quota or CPU set).
 * @param {typeof DEFAULT_MEASURES} [params.measures]
 */
export async function measureHost({ ffmpegBin, logger, transcode, processorCores, measures = DEFAULT_MEASURES }) {
  const {
    detectVideoEncoder, benchmarkDecodeCost, benchmarkContention, readHostFingerprint, calibrateEncoder,
    softwareDescriptor, benchmarkCopySpeed, benchmarkAudio, measureStartAndStop, detectTonemapSupport
  } = measures;
    // Auto-detect the best available H.264 encoder (hardware-accelerated or
    // software) once at startup, with a real test-encode and graceful fallback.
    // Only needed when transcoding can occur.
    let videoEncoder = transcode
      ? await detectVideoEncoder({ ffmpegBin, logger })
      : null;
    // WHAT THIS HOST DOES, measured before any viewer exists. Every one of these
    // was gated on the chosen encoder being SOFTWARE, and two of the three are
    // not about the encoder at all: a host with a GPU decodes in software just
    // the same — no hardware decoder is asked for anywhere — and what a second
    // job costs is a property of the machine. So a GPU host had no decode cost,
    // no contention penalty and no encoder throughput, and the quality offer,
    // which is arithmetic over those three, had nothing to compute from.
    //
    // The decode model first and the throughput second — they are independent
    // (the rungs are timed on raw frames), but the order keeps the two figures
    // side by side in the log.
    const decodeCostModel = transcode
      ? await benchmarkDecodeCost({ ffmpegBin, logger, processorCores })
      : null;
    // What a second job costs on this host. Measured because the budget adds
    // independent prices and this host says two jobs that each fit alone do not
    // fit together — 2.6× on the addon box (2026-08-18).
    const contentionPenalties = transcode
      ? await benchmarkContention({ ffmpegBin, logger })
      : null;
    // WHICH MODES THIS HOST MAY ENCODE WITH, AND WHAT EACH COSTS AT EVERY SIZE
    // (roadmap item 97, step 14). Every setting an output can actually be
    // encoded at is put through the product's own arguments and its segments
    // decoded, then timed at the sizes of the ladder; a mode that fails either is
    // not used, and a size nothing was timed at is not offered. Software is
    // calibrated too when detection chose a device: it is what a failing device
    // falls back to for the rest of the process, and it must not be priced by
    // the device's figures.
    //
    // And WHICH CONFIGURATION all of it describes — the ffmpeg and x264 builds,
    // the processor and the threads, the device and its driver — which is what
    // decides whether anything kept from an earlier run still applies.
    const fingerprint = videoEncoder
      ? await readHostFingerprint({ ffmpegBin, encoder: videoEncoder, processorCores })
      : null;
    /** @type {Record<string, object[]>} */
    const calibratedModes = {};
    if (videoEncoder) {
      const selectedCalibration = await calibrateEncoder({ ffmpegBin, encoder: videoEncoder, logger, processorCores });
      if (selectedCalibration.assessmentComplete) {
        calibratedModes[videoEncoder.kind] = selectedCalibration.modes;
      }
      if (videoEncoder.kind !== "software") {
        const softwareCalibration = await calibrateEncoder({ ffmpegBin, encoder: softwareDescriptor(), logger, processorCores });
        if (softwareCalibration.assessmentComplete) {
          calibratedModes.software = softwareCalibration.modes;
        }
        // A device that passed detection's own test and then none of whose modes
        // passed the product's is not used: detection encodes a synthetic pattern
        // with arguments of its own, and it is the product's arguments a viewer
        // is served with.
        if (Array.isArray(calibratedModes[videoEncoder.kind]) && calibratedModes[videoEncoder.kind].length === 0) {
          logger.warn(
            `calibration: ${videoEncoder.name} passed detection but none of its modes produced correct segments ` +
            "through the product's own arguments; encoding in software instead"
          );
          videoEncoder = softwareDescriptor();
        }
      }
    }
    const calibration = videoEncoder ? new HostCalibration({ byKind: calibratedModes, fingerprint }) : null;
    // What this host does with a picture it does NOT re-encode. Every other
    // startup measurement prices encoding or decoding, and a copied picture does
    // neither — it reads packets and writes them out again — so that whole branch
    // had no speed until its own run had been running long enough to report one.
    // The encoding layer decides where encoders go from arrivals, and an arrival
    // cannot be computed without a speed, so the moment it mattered most was the
    // moment nothing was known. Measured whatever the encoder is: copying does not
    // touch it.
    const copySpeedX = transcode
      ? await benchmarkCopySpeed({ ffmpegBin, logger })
      : null;
    const audioCalibration = transcode
      ? await benchmarkAudio({ ffmpegBin, logger })
      : [];
    // WHAT A START AND A STOP COST HERE, before any viewer exists. Both decide one
    // thing — leave an encoder where it stands, or kill it and start another —
    // and both used to be learned only from runs that had ENDED, so at a cold
    // open they were zero. Zero does not read as "not measured": it reads as
    // "free", and a free move is always taken. Field 2026-09-08: an encoder moved
    // between two adjacent numbers every half second and produced nothing.
    const startStopCost = transcode
      ? await measureStartAndStop({ ffmpegBin, encoder: videoEncoder, logger })
      : null;
    // Whether this ffmpeg build can tone-map HDR→SDR (zscale + tonemap filters).
    // Detected once; the session manager applies the tonemap chain only for HDR
    // sources on the software path when available.
    const tonemapSupported = transcode
      ? await detectTonemapSupport({ ffmpegBin, logger })
      : false;
  return { videoEncoder, decodeCostModel, contentionPenalties, calibration, copySpeedX, audioCalibration, startStopCost, tonemapSupported };
}
