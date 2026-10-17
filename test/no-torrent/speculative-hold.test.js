/**
 * @file The download gives way to the encoder a viewer needs first
 * (torrent-tv/meta#180, phase 5): what nobody needs yet is held back while
 * that encoder is short of the processor, and only where the swarm gives more
 * than its film needs.
 *
 * The wiring is real; the encoder's shortfall, the swarm's rate and the film
 * are given, so nothing encodes and nothing downloads.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { wireOutputs } from "../../services/server/wire-outputs.js";
import { SegmentStore } from "../../services/storage/segment-store/SegmentStore.js";
import { SourceFile } from "../../services/media/SourceFile.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { Output } from "../../services/encode/output/Output.js";
import { outputSpec } from "./helpers/output-spec.js";

function wired(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "speculative-hold-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const told = [];
  const parts = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    segmentStore: new SegmentStore({ root }),
    setSpeculativeHold: (held, because) => { told.push({ held, because }); }
  });
  t.after(() => clearInterval(parts.cleanupTimer));
  // A film of 4 GB over 8000 s: 0.5 MB per second of film.
  parts.outputs.outputsOn = () => [{ file: { key: "film", lengthBytes: 4e9, durationSeconds: 8000 } }];
  return { parts, told };
}

const SHORT = { address: "picture", speed: { middle: 1.0, scatter: 0.1 }, seconds: 5 };

test("short of the processor with a viewer waiting, and a swarm faster than the film: held", (t) => {
  const { parts, told } = wired(t);
  parts.encodeOrchestrator.processorShortfall = () => ({ ...SHORT, need: Number.POSITIVE_INFINITY });
  parts.hostLoad.swarmRate = () => 10e6;
  parts.applySpeculativeHold();
  assert.equal(told.length, 1);
  assert.equal(told[0].held, true);
  assert.match(told[0].because, /made 1\.00x \(scatter 0\.10\) over 5s with a viewer waiting; the swarm gives 10\.00 MB\/s, more than the 0\.55 MB\/s its film needs at 1\.10x/);
  parts.applySpeculativeHold();
  assert.equal(told.length, 1, "told only when it changes");
  parts.encodeOrchestrator.processorShortfall = () => null;
  parts.applySpeculativeHold();
  assert.deepEqual(told.map(({ held }) => held), [true, false]);
});

test("a swarm no faster than the film at the speed its deadlines need: not held", (t) => {
  const { parts, told } = wired(t);
  parts.encodeOrchestrator.processorShortfall = () => ({ ...SHORT, need: 1.5 });
  // 0.5 MB per film second at 1.5x needs 0.75 MB/s.
  parts.hostLoad.swarmRate = () => 0.7e6;
  parts.applySpeculativeHold();
  assert.equal(told.length, 0, "nothing was held, so nothing is said");
  parts.hostLoad.swarmRate = () => 0.8e6;
  parts.applySpeculativeHold();
  assert.equal(told.at(-1).held, true);
  assert.match(told.at(-1).because, /needing 1\.50x; the swarm gives 0\.80 MB\/s, more than the 0\.75 MB\/s its film needs at 1\.50x/);
});

test("an unmeasured swarm or film holds nothing back", (t) => {
  const { parts, told } = wired(t);
  parts.encodeOrchestrator.processorShortfall = () => ({ ...SHORT, need: Number.POSITIVE_INFINITY });
  parts.hostLoad.swarmRate = () => null;
  parts.applySpeculativeHold();
  parts.hostLoad.swarmRate = () => 10e6;
  parts.outputs.outputsOn = () => [];
  parts.applySpeculativeHold();
  assert.equal(told.length, 0);
});

test("the start forecast's wait is said in why the download was held", (t) => {
  const { parts, told } = wired(t);
  parts.encodeOrchestrator.processorShortfall = () => ({ ...SHORT, need: Number.POSITIVE_INFINITY, waitedFor: 1501 });
  parts.hostLoad.swarmRate = () => 10e6;
  parts.applySpeculativeHold();
  assert.equal(told.at(-1).held, true);
  assert.match(told.at(-1).because, /over 5s with a viewer waiting for its #1501 by the start forecast; the swarm gives/);
});

test("a viewer the start forecast holds for an encoder's piece is told to whoever shares the processor", async (t) => {
  const { parts } = wired(t);
  const OUTPUT = "surface:fmt=fmp4:grid=kf@0:video-only:v=0/copy";
  const session = {
    id: "aaaaaaaabbbbcccc",
    spec: outputSpec({ cutGrid: "keyframe", audioSeparate: false }),
    outputKey: OUTPUT,
    dirPath: path.join(os.tmpdir(), "speculative-hold-does-not-exist"),
    file: new SourceFile({ sourceKey: "torrent:abc", fileIndex: 0, name: "video.mkv" })
      .learn({ width: 1920, height: 1080, durationSeconds: 40 }),
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    timeline: new Timeline({ boundaries: Array.from({ length: 11 }, (_, index) => index * 4), cutGrid: "keyframe" }),
    segmentFormat: fmp4Format,
    output: new Output({ encodeWidth: 0, encodeHeight: 0, outputFps: 24, softwarePreset: null, applyTonemap: false }),
    transcodeVideo: false,
    transcodeAudio: true,
    audioTrackIndex: 0,
    audioSourceTrackIndex: 0,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentCount: 10,
    progress: { state: "running", processedSeconds: 0, startPositionSeconds: 0 }
  };
  parts.outputs.set(session.id, session);
  // A viewer at the start over a fast link; nothing is made; the encoder is
  // predicted at 0.5x and each piece reads its own 10 MB of a file still
  // downloading at 50 MB/s.
  parts.viewers.get = () => ({ linkReading: () => ({ linkSampleMbps: 100, linkSampleMeasuredAt: Date.now(),
    positionSeconds: 0, bufferedAheadSec: 0 }) });
  parts.encodeCost.projectedSpeedOf = () => 0.5;
  parts.sourceInputsFor = (_output, index) => [{ sourceId: "torrent:abc:0", ranges: [{ start: index * 1e7, end: (index + 1) * 1e7 }] }];
  let complete = false;
  parts.getSourceStats = async () => ({ fileAvailable: complete, downloadSpeed: 50e6, fileOffset: 0, fileLength: 1e8,
    pieceLength: 1 << 20 });
  const waits = [];
  parts.encodeOrchestrator.noteViewerWaiting = (viewer, wait) => { waits.push({ viewer, wait }); };
  const held = (await parts.viewerRequests.getSessionProgress(session.id, "viewer-one")).playbackReadiness.holdingBy;
  assert.equal(held.kind, "production");
  assert.deepEqual(waits.at(-1), { viewer: "viewer-one", wait: { address: OUTPUT, index: held.segment } });
  // The whole file is here: the forecast waits for no encoder's input, and
  // what holds the viewer, if anything, is no production.
  complete = true;
  const after = (await parts.viewerRequests.getSessionProgress(session.id, "viewer-one")).playbackReadiness.holdingBy;
  assert.notEqual(after?.kind, "production");
  assert.deepEqual(waits.at(-1), { viewer: "viewer-one", wait: null });
});
