/**
 * @file WHICH THREAD answers a pull for subtitle cues.
 *
 * Field 2026-09-03, on `[HorribleSubs] Drifters - 04 [1080p].mkv`. The file had
 * been downloaded in an earlier sitting, so the torrent worker's cluster walk
 * found cues 1.5 s after the file was opened and pushed four batches — cursor 1
 * to 31, covering everything up to 81.7 s — before the browser had subscribed.
 * The browser's catch-up pull, which exists for exactly that case, answered a
 * seven-byte `WEBVTT` with `x-subtitle-covered-clusters: 0` against 283
 * indexed. So the viewer watched the first 82 s with no subtitles and the rest
 * of the episode with them.
 *
 * The pull ran on the MAIN thread, where the torrent is a stand-in carrying
 * `infoHash`, `name` and a `files` list — no `bitfield`, no `pieceLength`. The
 * walk decides what it may read from those two, so every range read as "not
 * downloaded", nothing was walked, and an empty document came back. An empty
 * document is also the right answer for a file that holds no cues yet, which is
 * why nothing reported a failure.
 *
 * These checks pin the two halves of the repair: the pull is addressed to the
 * thread that owns the torrent, and a walk asked of a torrent that cannot say
 * what it holds says so rather than answering emptily.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SubtitleOrchestrator } from "../services/orchestrators/SubtitleOrchestrator.js";
import { cuesHeldFor } from "../services/torrent-worker/subtitle-cues.js";

/** The stand-in the main thread holds: a name, a file list, and no pieces. */
function mainThreadTorrent() {
  return {
    infoHash: "0".repeat(40),
    name: "[HorribleSubs] Drifters - 04 [1080p].mkv",
    sourceKey: "a".repeat(40),
    files: [{ name: "[HorribleSubs] Drifters - 04 [1080p].mkv", length: 567_535_843, createReadStream: () => { throw new Error("not reached"); } }]
  };
}

test("a pull is answered by the thread that owns the torrent, not walked here", async () => {
  const asked = [];
  const pool = {
    async getSubtitleCues(torrent, fileIndex, trackNumber) {
      asked.push({ sourceKey: torrent.sourceKey, fileIndex, trackNumber });
      return {
        cues: [{ startSeconds: 5.4, endSeconds: 9.1, text: "So what if you brought them over?", seq: 1 }],
        coveredClusters: 283,
        indexedClusters: 283,
        codecId: "S_TEXT/ASS",
        codecPrivate: "",
        language: ""
      };
    }
  };

  const orchestrator = new SubtitleOrchestrator({ forget() {} });
  const held = await orchestrator.getCues(pool, mainThreadTorrent(), 33, "a".repeat(40), 3);

  assert.deepEqual(asked, [{ sourceKey: "a".repeat(40), fileIndex: 33, trackNumber: 3 }]);
  assert.equal(held.cues.length, 1);
  assert.equal(held.coveredClusters, 283, "the walk's own figure travels back, so the header cannot claim 0 of 283");
  // The worker answers with the track's fields flat — only plain objects cross
  // the boundary — and the caller reads them through `held.track`.
  assert.equal(held.track.codecId, "S_TEXT/ASS");
});

test("the cursor of a pulled cue is the found-order the worker assigned", async () => {
  // The browser mixes cursors from pulls and pushes. Walking a second time on
  // another thread would start a second `seq` counter and the two would not be
  // comparable, which is the deeper reason the pull is not served locally.
  const pool = {
    async getSubtitleCues() {
      return {
        cues: [
          { startSeconds: 5.4, endSeconds: 9.1, text: "one", seq: 1 },
          { startSeconds: 81.7, endSeconds: 84.0, text: "two", seq: 31 }
        ],
        coveredClusters: 12,
        indexedClusters: 283,
        codecId: "S_TEXT/ASS",
        codecPrivate: "",
        language: ""
      };
    }
  };
  const orchestrator = new SubtitleOrchestrator({ forget() {} });
  const held = await orchestrator.getCues(pool, mainThreadTorrent(), 33, "a".repeat(40), 3);
  assert.deepEqual(held.cues.map((cue) => cue.seq), [1, 31]);
});

test("a pool with no channel to the worker is refused, not answered emptily", async () => {
  const orchestrator = new SubtitleOrchestrator({ forget() {} });
  const held = await orchestrator.getCues({}, mainThreadTorrent(), 33, "a".repeat(40), 3);
  assert.deepEqual(held, { cues: [], coveredClusters: 0, indexedClusters: 0, track: null });
});

test("the walk refuses a torrent that cannot say which pieces it holds", async () => {
  // Called directly, as the main thread used to call it. Without this guard the
  // answer is an empty list indistinguishable from a file with no cues, which
  // is what hid the defect for a whole session.
  const held = await cuesHeldFor(mainThreadTorrent(), 33, "b".repeat(40), 3);
  assert.deepEqual(held, { cues: [], coveredClusters: 0, indexedClusters: 0, track: null });
});
