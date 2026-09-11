/**
 * @file Files this proxy has downloaded whole, kept as files.
 *
 * A torrent is a way of GETTING bytes. Once every byte of a file is here, the
 * torrent has nothing left to do for it: the file is a file, and reading it is
 * an ordinary read of an ordinary file — no piece store, no memory ceiling, no
 * eviction, no revival from a spill, and nothing that can refuse a read for
 * want of memory.
 *
 * WHY THIS EXISTS AT ALL, in the words it was asked for (2026-09-11): as soon
 * as a torrent is fully downloaded, downloading stops, the torrent is deleted,
 * and the artefacts — what was downloaded — stay for as long as they are
 * wanted.
 *
 * WHERE THEY LIVE, and it is not beside the torrent's own store. Destroying a
 * torrent with `destroyStore` removes that directory whole, which is exactly
 * what the instruction above ends with — so a file kept inside it would be
 * deleted by the very act it is meant to survive.
 *
 * WHAT IS HERE IS ADOPTED AT STARTUP, for the same reason the piece store
 * adopts its own directory: a proxy that has restarted has these files and must
 * not fetch them again. A file whose size does not match what the torrent says
 * is not adopted — it was being written when the process died.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Where whole files live.
 *
 * Beside the torrents' own directories and not inside them: destroying a
 * torrent with its store removes that directory whole, and these files exist to
 * survive exactly that.
 *
 * @returns {string}
 */
export function completedFilesRoot() {
  return path.join(os.tmpdir(), "torrent-tv-files");
}

/** How a removal is asked for; Windows needs the retries, POSIX ignores them. */
const REMOVAL = { force: true, maxRetries: 10, retryDelay: 20 };

/**
 * One directory of whole files, keyed by the torrent they came from.
 */
export class CompletedFiles {
  #root;

  /** `${infoHash}/${fileIndex}` → what is held. @type {Map<string, { path: string, length: number, name: string }>} */
  #held = new Map();

  /** Assemblies in flight, so two passes cannot write one file at once. @type {Set<string>} */
  #writing = new Set();

  /**
   * @param {object} params
   * @param {string} params.root - Where whole files live. Outside any torrent's
   *   own store directory, which is removed with the torrent.
   */
  constructor({ root }) {
    this.#root = root;
  }

  /** Where these files live, for logging. */
  get root() {
    return this.#root;
  }

  /** How many whole files are held. */
  get size() {
    return this.#held.size;
  }

  /** What they weigh. */
  get bytes() {
    let total = 0;
    for (const file of this.#held.values()) {
      total += file.length;
    }
    return total;
  }

  /**
   * @param {string} infoHash
   * @param {number} fileIndex
   * @returns {string}
   */
  #keyOf(infoHash, fileIndex) {
    return `${String(infoHash)}/${fileIndex}`;
  }

  /**
   * The whole file for this torrent and index, or null.
   *
   * @param {string} infoHash
   * @param {number} fileIndex
   * @returns {{ path: string, length: number, name: string } | null}
   */
  find(infoHash, fileIndex) {
    return this.#held.get(this.#keyOf(infoHash, fileIndex)) ?? null;
  }

  /**
   * Take up whole files a previous life of this proxy left here.
   *
   * @param {(infoHash: string, fileIndex: number) => number | null} lengthOf -
   *   What the torrent says this file weighs, or null when it is not known. A
   *   file of the wrong size was being written when the process died and is not
   *   adopted.
   * @returns {Promise<number>} How many were taken up.
   */
  async adopt(lengthOf) {
    let adopted = 0;
    let torrents = [];
    try {
      torrents = await fs.readdir(this.#root, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of torrents) {
      if (!entry.isDirectory()) {
        continue;
      }
      const infoHash = entry.name;
      let files = [];
      try {
        files = await fs.readdir(path.join(this.#root, infoHash), { withFileTypes: true });
      } catch {
        continue;
      }
      let manifest = {};
      try {
        manifest = JSON.parse(
          await fs.readFile(path.join(this.#root, infoHash, "manifest.json"), "utf8")
        );
      } catch {
        // No manifest, or an unreadable one: the bytes are still servable, and
        // a file named by its number is better than a file thrown away.
      }
      for (const held of files) {
        const fileIndex = Number.parseInt(held.name, 10);
        if (!held.isFile() || !Number.isInteger(fileIndex) || fileIndex < 0) {
          continue;
        }
        const where = path.join(this.#root, infoHash, held.name);
        try {
          const { size } = await fs.stat(where);
          const expected = lengthOf(infoHash, fileIndex);
          if (expected !== null && size !== expected) {
            await fs.rm(where, REMOVAL);
            continue;
          }
          this.#held.set(this.#keyOf(infoHash, fileIndex), {
            path: where,
            length: size,
            name: String(manifest?.[String(fileIndex)]?.name ?? fileIndex)
          });
          adopted += 1;
        } catch {
          // Gone between the listing and the reading: not ours to worry about.
        }
      }
    }
    return adopted;
  }

  /**
   * Write one whole file out of whatever the torrent can read it from.
   *
   * Written under a name nothing serves and renamed when it is closed, so a
   * process killed halfway leaves no file that looks complete. The rename is
   * the one moment at which the file becomes servable, which is also why
   * nothing has to be locked against readers.
   *
   * @param {object} params
   * @param {string} params.infoHash
   * @param {number} params.fileIndex
   * @param {number} params.length - What the torrent says the file weighs.
   * @param {string} params.name - What the torrent calls it. Kept because the
   *   torrent is what is about to be deleted, and a file with no name can only
   *   be served as a number.
   * @param {() => NodeJS.ReadableStream} params.open - The torrent's own read of
   *   the whole file.
   * @returns {Promise<{ path: string, length: number } | null>} Null when
   *   another pass is already writing it, or when what was read does not weigh
   *   what the torrent said.
   */
  async keep({ infoHash, fileIndex, length, name, open }) {
    const key = this.#keyOf(infoHash, fileIndex);
    const held = this.#held.get(key);
    if (held) {
      return held;
    }
    if (this.#writing.has(key)) {
      return null;
    }
    this.#writing.add(key);
    const directory = path.join(this.#root, String(infoHash));
    const where = path.join(directory, String(fileIndex));
    const partial = `${where}.partial`;
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.rm(partial, REMOVAL);
      const source = open();
      const handle = await fs.open(partial, "w");
      let written = 0;
      try {
        for await (const chunk of source) {
          await handle.write(chunk);
          written += chunk.length;
        }
      } finally {
        await handle.close();
      }
      if (written !== length) {
        // The read ended early — the data went away mid-write, which over a
        // torrent is ordinary. What must not happen is a short file under a
        // name that says it is whole.
        await fs.rm(partial, REMOVAL);
        return null;
      }
      await fs.rename(partial, where);
      const file = { path: where, length, name: String(name ?? fileIndex) };
      this.#held.set(key, file);
      await this.#writeManifest(infoHash);
      return file;
    } catch {
      await fs.rm(partial, REMOVAL).catch(() => undefined);
      return null;
    } finally {
      this.#writing.delete(key);
    }
  }

  /**
   * Write down what each file of one torrent is called and weighs.
   *
   * The torrent is what is about to be deleted, and it is the only thing that
   * knows either. A number on disk is enough to serve the bytes and not enough
   * to say what they are.
   *
   * @param {string} infoHash
   * @returns {Promise<void>}
   */
  async #writeManifest(infoHash) {
    const named = {};
    for (const [key, file] of this.#held) {
      if (key.startsWith(`${infoHash}/`)) {
        named[key.slice(infoHash.length + 1)] = { length: file.length, name: file.name };
      }
    }
    await fs
      .writeFile(path.join(this.#root, String(infoHash), "manifest.json"), JSON.stringify(named))
      .catch(() => undefined);
  }

  /**
   * Forget and remove every whole file of one torrent.
   *
   * @param {string} infoHash
   * @returns {Promise<void>}
   */
  async forget(infoHash) {
    for (const key of [...this.#held.keys()]) {
      if (key.startsWith(`${infoHash}/`)) {
        this.#held.delete(key);
      }
    }
    await fs.rm(path.join(this.#root, String(infoHash)), { ...REMOVAL, recursive: true }).catch(
      () => undefined
    );
  }
}
