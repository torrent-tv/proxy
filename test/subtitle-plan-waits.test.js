/**
 * @file The subtitle plan is kept only once it has been read; a plan whose
 * read finishes later serves the same pass; and cues the container takes back
 * leave by the numbers they were sent under.
 *
 * Fakes only: a stand-in container and a held file of plain functions.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { cuesHeldFor, forgetSubtitles, subtitleTracksOf, warmSubtitleCues } from "../services/media/SubtitleCues.js";
import { BytesUnavailable } from "../services/media/container/unavailable.js";

const PLAN = {
  tracks: [{ trackNumber: 2, declaredIndex: 0, codecId: "S_TEXT/UTF8", language: "eng", languageSource: "default", clusterPositions: [] }],
  declared: [],
  secondsPerTick: 0.001,
  segmentDataOffset: 0
};

function heldFile(sourceKey, container) {
  return {
    sourceKey,
    fileIndex: 0,
    name: "film.mkv",
    length: 1000,
    container: async () => container(),
    heldRanges: async () => [[0, 999]],
    readHeld: async () => Buffer.alloc(0)
  };
}

test("a plan whose bytes have not arrived is not kept; the next ask reads it", async () => {
  const sourceKey = "p".repeat(40);
  forgetSubtitles(sourceKey);
  let here = false;
  const container = () => {
    if (!here) {
      throw new BytesUnavailable(900, 999, 0);
    }
    return { readSubtitlePlan: async () => PLAN, readHeldCues: async () => ({ found: new Map(), covered: 0, indexed: 0, withdrawn: [] }) };
  };
  try {
    assert.deepEqual(await subtitleTracksOf(heldFile(sourceKey, container)), []);
    here = true;
    const tracks = await subtitleTracksOf(heldFile(sourceKey, container));
    assert.deepEqual(tracks.map((track) => [track.trackNumber, track.language, track.languageSource]), [[2, "eng", "default"]]);
  } finally {
    forgetSubtitles(sourceKey);
  }
});

test("a plan read that finishes later serves the pass that asked, with no further arrival", async () => {
  const sourceKey = "q".repeat(40);
  forgetSubtitles(sourceKey);
  let release;
  let walks = 0;
  const arrived = new Promise((resolve) => {
    release = resolve;
  });
  const container = {
    readSubtitlePlan: async () => {
      await arrived;
      return PLAN;
    },
    // A cluster is read once: the first pass finds the line, later ones nothing.
    readHeldCues: async () => {
      walks += 1;
      return {
        found: walks === 1 ? new Map([[2, [{ startSeconds: 1, endSeconds: 2, text: "line", source: 77 }]]]) : new Map(),
        covered: 1,
        indexed: 1,
        withdrawn: []
      };
    }
  };
  try {
    // The file is one somebody asked about: a browser's seed is under way.
    const seed = cuesHeldFor(heldFile(sourceKey, () => container), 2);
    const warm = warmSubtitleCues(heldFile(sourceKey, () => container));
    release();
    await seed;
    const entries = await warm;
    assert.equal(entries.length, 1, "the one pass pushed what the plan led to");
    assert.deepEqual(entries[0].cues.map((cue) => [cue.text, cue.seq]), [["line", 1]]);
  } finally {
    forgetSubtitles(sourceKey);
  }
});

test("cues read from a position the container withdraws are taken back by their numbers", async () => {
  const sourceKey = "r".repeat(40);
  forgetSubtitles(sourceKey);
  let passNumber = 0;
  const container = {
    readSubtitlePlan: async () => PLAN,
    readHeldCues: async () => {
      passNumber += 1;
      return passNumber === 1
        ? {
            found: new Map([[2, [
              { startSeconds: 1, endSeconds: 2, text: "real", source: 10 },
              { startSeconds: 3, endSeconds: 4, text: "false", source: 50 }
            ]]]),
            covered: 2,
            indexed: 2,
            withdrawn: []
          }
        : { found: new Map(), covered: 1, indexed: 1, withdrawn: [50] };
    }
  };
  try {
    await subtitleTracksOf(heldFile(sourceKey, () => container));
    const first = await warmSubtitleCues(heldFile(sourceKey, () => container));
    assert.deepEqual(first[0].cues.map((cue) => [cue.text, cue.seq]), [["real", 1], ["false", 2]]);
    const second = await warmSubtitleCues(heldFile(sourceKey, () => container));
    assert.deepEqual(second[0].withdrawn, [2], "the false cue is named by the number it was sent under");
    assert.deepEqual(second[0].cues, []);
    const held = await cuesHeldFor(heldFile(sourceKey, () => container), 2);
    assert.deepEqual(held.cues.map((cue) => cue.text), ["real"], "and it is gone from what is held");
  } finally {
    forgetSubtitles(sourceKey);
  }
});
