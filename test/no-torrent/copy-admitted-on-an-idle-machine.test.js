/**
 * @file A copy the machine makes at many times realtime is admitted on an idle
 * machine (torrent-tv/meta#414).
 *
 * Field 2026-11-10: the one-piece run of #9 of `Below.S01E01` copied 10.417 s
 * of film in 1.284 s of its own work while 16 % of the machine was left to
 * encoders. Its reading was filed as a price, and 48 minutes later, with 83 %
 * of the machine to spare and nothing running, the output was refused with
 * "0.12x of every output with one more encoder". Here a real `EncodeRun` over
 * a fake process makes the reading, the real `EncodeCost` files it, and the
 * real `EncodeAdmission` is asked; the process, the clock and the host's
 * figures are fakes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EncodeRun } from "../../services/encode/EncodeRun.js";
import { EncodeAdmission } from "../../services/encode/EncodeAdmission.js";
import { SoftwareEncoder } from "../../services/encode/SoftwareEncoder.js";
import { EncodeCost } from "../../services/encode/quality/EncodeCost.js";
import { runStateOf } from "../../services/encode/encode-run-state.js";
import { outputSpec } from "./helpers/output-spec.js";

const ADDRESS = "torrent:cfbe:fmt=fmp4:grid=kf@0:video-only:v=0/copy";

/** What encoders were left while the run was read, and what the machine has to spare when it is asked. */
const LEFT_WHEN_READ = 0.16;
const SPARE_WHEN_ASKED = 0.83;

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdin = new EventEmitter();
    this.stdout = new EventEmitter();
    this.stdio = [null, this.stdout, null, new EventEmitter()];
  }

  kill() {}
}

/** A copied output of `Below.S01E01`, learned from nothing yet, and the cost that owns what runs make of it learn. */
function theCopiedOutput() {
  const session = {
    id: "cfbe000011112222",
    outputKey: ADDRESS,
    state: "ready",
    spec: outputSpec({ transcodeVideo: false }),
    file: { key: "torrent:cfbe:0", name: "Below.S01E01.1080p.rus.LostFilm.TV.mkv" },
    output: { encodeWidth: 0, encodeHeight: 0, outputFps: 24, softwarePreset: null },
    runs: new Set()
  };
  const cost = new EncodeCost({
    outputs: { familyOf: () => [], variantHeightOf: () => 0, outputsOn: (address) => (address === ADDRESS ? [session] : []) },
    host: () => ({
      benchmark: null,
      decodeModel: null,
      contentionPenalties: null,
      availability: { known: true, share: LEFT_WHEN_READ, forEncoders: LEFT_WHEN_READ }
    }),
    runningEncoders: () => 1,
    encodersRunningNow: () => 0,
    torrentCostSecFor: () => 0,
    runsFor: (owner) => [...(owner.runs ?? [])],
    stateFor: (owner) => runStateOf(owner.runs)
  });
  return { session, cost };
}

/** An admission over that cost, asked on a machine with nothing running and nothing held. */
function idleMachineAskingTheCost(cost) {
  return new EncodeAdmission({
    liveRunsByAddress: () => new Map(),
    preparedAddresses: () => new Set(),
    loadOf: (address) => cost.loadOfOutput(address),
    finished: () => false,
    availability: () => ({ share: SPARE_WHEN_ASKED, known: true })
  });
}

/** The run of the field: from 93.750 s, its piece ends at 104.167 s, named closed after 1.284 s of work. */
function theFieldRun(session) {
  const clock = { at: 1000 };
  const process_ = new FakeProcess();
  const run = new EncodeRun({
    address: ADDRESS, encoder: new SoftwareEncoder(), from: 9, to: 9, startSeconds: 93.75,
    buildArgs: () => [], spawn: () => process_, logger: { info() {}, warn() {} },
    now: () => clock.at, publishesAlone: true,
    indexOfName: (name) => Number(/(\d+)\.mp4$/.exec(name)?.[1]),
    pieceEndSeconds: (index) => (index === 9 ? 104.167 : null),
    onClosed: (name) => name
  });
  session.runs.add(run);
  const report = (seconds) => process_.stdout.emit("data", `out_time_ms=${Math.round(seconds * 1_000_000)}\n`);
  run.inputWaitBegins();
  clock.at += 400;
  report(10.40);
  run.inputWaitEnds();
  clock.at += 1284;
  process_.stdio[3].emit("data", "making-0-00009.mp4\n");
  // The encoder lives on after it names the piece, and says so once more.
  clock.at += 700;
  report(10.417);
  return run;
}

test("a copy read at 8.1x with 16 % left to encoders is admitted on an idle machine with 83 % to spare", async () => {
  const { session, cost } = theCopiedOutput();
  const run = theFieldRun(session);

  await cost.learnFrom(session, run);

  const answer = idleMachineAskingTheCost(cost).admitsWatching(ADDRESS);
  assert.equal(answer.admitted, true, answer.reason);
  assert.ok(answer.speedX > 1, `the machine would make ${answer.speedX}x`);
  const price = cost.loadOfOutput(ADDRESS);
  assert.ok(Math.abs(price.costSec - LEFT_WHEN_READ / (10.417 / 1.284)) < 1e-3, `priced at ${price.costSec} s of work per second of film`);
});

test("the same output read at the field's old 0.024x is refused with 0.12x, the arithmetic the fix leaves alone", async () => {
  const { session, cost } = theCopiedOutput();
  theFieldRun(session);

  await cost.learnFrom(session, { speedReading: { speed: 0.024 } });

  const answer = idleMachineAskingTheCost(cost).admitsWatching(ADDRESS);
  assert.equal(answer.admitted, false);
  assert.match(answer.reason, /would make 0\.12x of every output with one more encoder/);
});
