/**
 * @file Software rate limits follow the source picture rate and output area.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { h264LevelFor, nominalKbpsFor, softwareRateControlFor } from "../../services/encode/args.js";
import { sourcePictureBitrateKbps } from "../../services/media/SourceFile.js";

const AVI_SOURCE = Object.freeze({ width: 720, height: 400, pictureKbps: 2136 });

test("the film picture rate is the container rate minus its embedded audio rates", () => {
  assert.equal(sourcePictureBitrateKbps({
    bitrateKbps: 2323,
    audioTracks: [{ bitrateKbps: 187 }]
  }), 2136);
});

test("an unknown rate for any embedded soundtrack leaves the picture rate unknown", () => {
  assert.equal(sourcePictureBitrateKbps({
    bitrateKbps: 2323,
    audioTracks: [{ bitrateKbps: 187 }, { bitrateKbps: null }]
  }), null);
  assert.equal(sourcePictureBitrateKbps({ bitrateKbps: 2323 }), null);
});

test("the nominal follows source rate and output area, including a downscale", () => {
  assert.equal(nominalKbpsFor({ width: 720, height: 400 }, AVI_SOURCE), 2136);
  assert.equal(nominalKbpsFor({ width: 360, height: 200 }, AVI_SOURCE), 534);
});

test("a source without a known picture rate gets no ceiling", () => {
  assert.equal(nominalKbpsFor({ width: 720, height: 400 }, null), null);
  assert.equal(softwareRateControlFor({ width: 720, height: 400, fps: 24 }), null);
});

test("lower limits keep the H.264 level of this file and frame", () => {
  const nominal = softwareRateControlFor({ ...AVI_SOURCE, fps: 24, source: AVI_SOURCE });
  const lower = softwareRateControlFor({
    width: 720, height: 400, fps: 24, source: AVI_SOURCE, capKbps: 1200
  });
  assert.equal(nominal.maxrateKbps, Math.round(2136 * 1.3));
  assert.equal(lower.level, nominal.level);
  assert.equal(nominal.level, h264LevelFor({
    width: 720, height: 400, fps: 24,
    maxrateKbps: nominal.maxrateKbps,
    bufsizeKbps: Math.round(2136 * 1.5)
  }));
});

test("a frame without a positive area has no nominal rate", () => {
  assert.equal(nominalKbpsFor({ width: 0, height: 720 }, AVI_SOURCE), null);
});
