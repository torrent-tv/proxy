/**
 * @file A file kept whole is read from the disk by the subtitle walk.
 *
 * Once a file is kept whole its pieces leave the torrent's store while the
 * bitfield still says they are held, and a read through the torrent waited on
 * a store that no longer had them (field 2026-10-01). The reading itself is
 * checked here over a temporary file; the client that uses it starts the
 * torrent thread and is not built.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readWholeFile } from "../services/torrent/worker/client.js";

test("a range of a whole file is read from the disk, and a range past it is not here", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ttv-whole-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "film.mkv");
  await writeFile(file, Buffer.from("0123456789"));
  const whole = { path: file, length: 10, name: "film.mkv" };

  assert.equal((await readWholeFile(whole, 2, 5)).toString(), "2345");
  assert.equal((await readWholeFile(whole, 8, 20)).toString(), "89", "clamped to the file");
  assert.equal(await readWholeFile(whole, 12, 20), null);
  await assert.rejects(readWholeFile({ ...whole, path: path.join(dir, "gone.mkv") }, 0, 1), { code: "ENOENT" });
});
