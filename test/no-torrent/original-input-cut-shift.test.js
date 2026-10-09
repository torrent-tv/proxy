/**
 * @file A copied soundtrack's pieces are judged on the clock the segment muxer
 * cut them by: from the run's first packet, not from the start it was asked for.
 *
 * Field 2026-10-09, `[HorribleSubs] Drifters - 01 [1080p].mkv` (AAC 44.1 kHz in
 * Matroska): every run of the soundtrack was refused for
 * `segment-end-outside-interval-soun` and the player stopped. The run was asked
 * to start at 10.385 s; its first AAC packet was at 10.403 s; the muxer, which
 * counts its cut times from that packet, closed the first piece at 20.805 s
 * against a cut at 20.771 s.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegBin from "ffmpeg-static";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { cutShiftOf, judgePiece } from "../../services/encode/piece-completeness.js";

// Generated ordinary media only; no torrent imports.
test("each piece of a copied AAC run is whole on the muxer's own clock, and only on it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv8-cut-shift-"));
  try {
    const run = (args) => {
      const result = spawnSync(ffmpegBin, args, { cwd: directory, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    };
    run(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "40", "-c:a", "aac", "-b:a", "128k", "input.mkv"]);
    // The field command, as the run built it.
    const grid = [0, 10.385, 20.771, 31.156];
    run(["-v", "error", "-seek_timestamp", "1", "-noaccurate_seek", "-ss", String(grid[1]), "-i", "input.mkv",
      "-copyts", "-output_ts_offset", String(grid[1]), "-to", String(grid[3]), "-ss", String(grid[1]), "-vn", "-map", "0:a:0?",
      "-c:a", "copy", "-avoid_negative_ts", "disabled", "-f", "segment",
      "-segment_times", `${(grid[2] - grid[1]).toFixed(3)},${(grid[3] - grid[1]).toFixed(3)}`, "-segment_time_delta", "0",
      "-segment_start_number", "1", "-segment_list", "list.csv", "-segment_list_type", "csv",
      "-segment_format", "mp4", "-segment_format_options",
      "movflags=+frag_keyframe+empty_moov+default_base_moof+delay_moov:avoid_negative_ts=disabled:movie_timescale=1000000",
      "making-%05d.mp4"]);
    const pieces = await Promise.all([1, 2].map(async (index) =>
      fmp4Format.readMediaRanges(await fs.readFile(path.join(directory, `making-${String(index).padStart(5, "0")}.mp4`)))));

    // The end of the first piece in the muxer's clock, as its segment list states it.
    const list = await fs.readFile(path.join(directory, "list.csv"), "utf8");
    const endSeconds = Number(list.trim().split("\n")[0].trim().split(",")[2]);
    const shift = cutShiftOf(pieces[0], grid[1], "soun", BigInt(Math.round(endSeconds * 1_000_000)));
    assert.ok(shift !== null && shift > 0 && shift < 1024 / 44100, `the first packet lies within one frame after the start: ${shift}`);
    // On the requested clock the first piece overruns its cut by more than a frame.
    assert.equal(judgePiece(fmp4Format, pieces[0], undefined, { from: grid[1], to: grid[2], requiredKinds: ["soun"] }).whole, false);
    for (const [offset, ranges] of pieces.entries()) {
      ranges.cutShiftSeconds = shift;
      const interval = { from: grid[1 + offset], to: grid[2 + offset], requiredKinds: ["soun"] };
      const judged = judgePiece(fmp4Format, ranges, undefined, interval);
      assert.equal(judged.whole, true, JSON.stringify({ offset, judged }));
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a first piece that starts more than a frame away from its start gives no shift", () => {
  const ranges = { tracks: [{ kind: "soun", timescale: 44100n, productionFrame: 1024n, positionErrorTicks: 0n,
    ranges: [{ start: BigInt(Math.round(10.5 * 44100)), end: BigInt(Math.round(20.8 * 44100)), frame: 1024n }] }] };
  assert.equal(cutShiftOf(ranges, 10.385, "soun"), null);
  assert.equal(cutShiftOf(ranges, 10.385, "vide"), null);
});
