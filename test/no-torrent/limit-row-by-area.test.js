/**
 * @file The row of bitrate limits is chosen by the AREA of the frame, not by
 * its height (roadmap item 97, step 14; decided with the user 2026-09-24).
 *
 * The rows are the frames of the ladder at 16:9, as the encode itself sizes
 * them. A frame takes the row nearest by the ratio of areas; on the exact
 * border the larger row wins; a row with no nominal of its own takes the
 * nominal of the nearest row that has one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { h264LevelFor, limitRowFor, nominalKbpsFor, softwareRateControlFor } from "../../services/encode/args.js";

test("a 2.4:1 film in a 1080 box is priced as 1080, not as 720", () => {
  // 1920x800 is 1.54 million points: 1.35 times below the 1080 row, 1.67
  // times above the 720 row. A height alone put it in the 720 row.
  assert.equal(limitRowFor({ width: 1920, height: 800 }), 1080);
  assert.equal(nominalKbpsFor({ width: 1920, height: 800 }), nominalKbpsFor({ width: 1920, height: 1080 }));
});

test("the 16:9 frames of the ladder each land in their own row", () => {
  for (const [width, height] of [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [960, 540], [852, 480], [640, 360], [426, 240]]) {
    assert.equal(limitRowFor({ width, height }), height, `${width}x${height}`);
  }
});

test("a wide 720 frame falls in the 540 row and takes the nominal the 540 row borrows", () => {
  // 1280x534 is 0.68 million points: 1.32 times above the 540 row and 1.35
  // times below the 720 row. The 540 row has no nominal of its own yet, and the
  // nearest row by area that has one is 480.
  assert.equal(limitRowFor({ width: 1280, height: 534 }), 540);
  assert.equal(nominalKbpsFor({ width: 1280, height: 534 }), nominalKbpsFor({ width: 852, height: 480 }));
});

test("on the exact border between two rows the larger row wins", () => {
  // The border between 1280x720 (921600) and 1920x1080 (2073600) is their
  // geometric mean, 1382400 = 1440x960, 1.5 times from each.
  assert.equal(limitRowFor({ width: 1440, height: 960 }), 1080);
});

test("rows with no nominal of their own borrow the nearest row that has one", () => {
  assert.equal(nominalKbpsFor({ width: 2560, height: 1440 }), nominalKbpsFor({ width: 1920, height: 1080 }));
  assert.equal(nominalKbpsFor({ width: 3840, height: 2160 }), nominalKbpsFor({ width: 1920, height: 1080 }));
  assert.equal(nominalKbpsFor({ width: 960, height: 540 }), nominalKbpsFor({ width: 852, height: 480 }));
});

test("the level of a wide frame is declared from the nominal of its row", () => {
  const control = softwareRateControlFor({ width: 1920, height: 800, fps: 24 });
  const nominal = nominalKbpsFor({ width: 1920, height: 1080 });
  assert.equal(
    control.level,
    h264LevelFor({ width: 1920, height: 800, fps: 24, maxrateKbps: control.maxrateKbps, bufsizeKbps: control.bufsizeKbps })
  );
  assert.equal(control.maxrateKbps, Math.round(nominal * 1.3));
});

test("a frame with no area is refused rather than priced", () => {
  assert.throws(() => limitRowFor({ width: 0, height: 720 }), RangeError);
});
