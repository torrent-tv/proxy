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
