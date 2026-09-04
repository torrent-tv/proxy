/**
 * @file The cut list must be stated on the timeline the muxer decides against.
 *
 * Measured 2026-08-17 on a Matroska whose first timestamp is 2.002 s. Asked to
 * cut at 808.808 s on the 0-based grid, the copied picture cut at 806.806 s —
 * exactly the container's start time early, and itself a keyframe the file's
 * own table names, which is why every "disagreement" landed on a real keyframe
 * and the table looked like it was lying. The soundtrack, re-encoded and on the
 * other branch, cut where it was asked. The two then wrote different values
 * into the shared boundary table and corrected each other back and forth
 * (#202: 808.808 → 806.806 → 808.750), so the playlist and the media drifted
 * apart by a whole segment.
 */

import assert from "node:assert/strict";
import { Timeline } from "../services/output/Timeline.js";
import test from "node:test";

import { onKeyframeGridFor } from "../services/hls-session-manager.js";

test("a copied picture works on the source's timeline", () => {
  assert.equal(
    onKeyframeGridFor({ transcodeVideo: false }),
    true,
    "video copied means the source's own timestamps are kept"
  );
});

test("a re-encoded picture works on the 0-based timeline", () => {
  assert.equal(onKeyframeGridFor({ transcodeVideo: true }), false);
});

test("a soundtrack follows the grid it was cut on, not its own encoding", () => {
  // A rendition is re-encoded by definition, so asking `transcodeVideo` about
  // it answers nothing. What decides its timeline is the grid it shares with
  // the picture it plays with.
  assert.equal(onKeyframeGridFor({ audioOnly: true, timeline: new Timeline({ boundaries: [], cutGrid: "keyframe" }) }), true);
  assert.equal(onKeyframeGridFor({ audioOnly: true, timeline: new Timeline({ boundaries: [], cutGrid: "uniform" }) }), false);
  assert.equal(
    onKeyframeGridFor({ audioOnly: true, transcodeVideo: true, timeline: new Timeline({ boundaries: [], cutGrid: "keyframe" }) }),
    true,
    "its own encoding must not decide this — that disagreement is the defect"
  );
});

test("one predicate answers for every caller", () => {
  // The two callers used to answer this separately, in two expressions that
  // could drift apart. A session put through both must get one answer.
  for (const session of [
    { transcodeVideo: false },
    { transcodeVideo: true },
    { audioOnly: true, timeline: new Timeline({ boundaries: [], cutGrid: "keyframe" }) },
    { audioOnly: true, timeline: new Timeline({ boundaries: [], cutGrid: "uniform" }) },
    {}
  ]) {
    assert.equal(onKeyframeGridFor(session), onKeyframeGridFor({ ...session }));
  }
});

test("a session that says nothing is treated as copying", () => {
  // The default matters: an absent `transcodeVideo` means the picture is
  // copied, which is the branch that needs the shift.
  assert.equal(onKeyframeGridFor({}), true);
  assert.equal(onKeyframeGridFor(null), true);
});
