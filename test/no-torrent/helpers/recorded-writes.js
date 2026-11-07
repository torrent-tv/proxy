/**
 * @file Watches which files a piece of code writes and renames, without
 * knowing HOW it does either.
 *
 * `fs.writeFileSync`, `fs.renameSync`, and the promise forms `writeFile` and
 * `rename` are wrapped (they still run), and `syncBuiltinESMExports` makes the
 * named imports of every module see the wrappers. So a check can say "the
 * final file was never written in place; it appeared by a rename" and stay
 * true whichever of those four calls the owner uses.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

/**
 * @typedef {{ op: "write" | "rename", target: string, from?: string }} Recorded
 */

/**
 * @param {string} inside - Only paths under this directory are recorded.
 * @returns {{ records: Recorded[], restore: () => void }}
 */
export function recordWrites(inside) {
  /** @type {Recorded[]} */
  const records = [];
  const under = (candidate) => typeof candidate === "string" && path.resolve(candidate).startsWith(path.resolve(inside) + path.sep);
  const original = {
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    writeFile: fsp.writeFile,
    rename: fsp.rename
  };
  const noteWrite = (target) => {
    if (under(target)) records.push({ op: "write", target: path.resolve(target) });
  };
  const noteRename = (from, target) => {
    if (under(target)) records.push({ op: "rename", target: path.resolve(target), from: path.resolve(from) });
  };
  fs.writeFileSync = function (target, ...rest) { noteWrite(target); return original.writeFileSync.call(this, target, ...rest); };
  fs.renameSync = function (from, target) { noteRename(from, target); return original.renameSync.call(this, from, target); };
  fsp.writeFile = function (target, ...rest) { noteWrite(target); return original.writeFile.call(this, target, ...rest); };
  fsp.rename = function (from, target) { noteRename(from, target); return original.rename.call(this, from, target); };
  syncBuiltinESMExports();
  return {
    records,
    restore() {
      fs.writeFileSync = original.writeFileSync;
      fs.renameSync = original.renameSync;
      fsp.writeFile = original.writeFile;
      fsp.rename = original.rename;
      syncBuiltinESMExports();
    }
  };
}

/**
 * The refusal text for a file that was written in place or never renamed into
 * place, or null when it appeared by a rename alone.
 *
 * @param {Recorded[]} records
 * @param {string} finalPath
 * @returns {string | null}
 */
export function whyNotAtomic(records, finalPath) {
  const target = path.resolve(finalPath);
  const direct = records.filter((record) => record.op === "write" && record.target === target);
  if (direct.length > 0) {
    return `${path.basename(target)} was written in place ${direct.length} time(s); it must be written to a temporary file and renamed`;
  }
  if (!records.some((record) => record.op === "rename" && record.target === target)) {
    return `${path.basename(target)} was never renamed into place (writes seen: ${JSON.stringify(records.map((r) => `${r.op}:${path.basename(r.target)}`))})`;
  }
  return null;
}
