import nodeFs from "node:fs";
import path from "node:path";

let writes = 0;

/**
 * Write a file so that a reader (or a restart after a crash) sees either the
 * previous content or the new content, never a half-written file: the text goes
 * to a temporary file beside the target, then is renamed over it. Synchronous;
 * throws on failure and removes its temporary file when it can. It never writes
 * `filePath` itself.
 *
 * @param {string} filePath
 * @param {string | Uint8Array} data
 * @param {{ fs?: Partial<typeof nodeFs>, mode?: number }} [options] - `fs`
 *   overrides individual `node:fs` functions (a check stops the write between
 *   the two steps with it).
 * @returns {void}
 */
export function writeFileAtomic(filePath, data, { fs = {}, mode } = {}) {
  const io = { ...nodeFs, ...fs };
  const temporary = path.join(path.dirname(filePath), `${path.basename(filePath)}.${process.pid}.${++writes}.tmp`);
  try {
    io.writeFileSync(temporary, data, mode === undefined ? undefined : { mode });
    io.renameSync(temporary, filePath);
  } catch (error) {
    try {
      nodeFs.rmSync(temporary, { force: true });
    } catch {
      // The write already failed; a temporary file that cannot be removed is the lesser fault.
    }
    throw error;
  }
}

/**
 * Serialise `value` as JSON and write it with {@link writeFileAtomic}.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {{ fs?: Partial<typeof nodeFs>, mode?: number }} [options]
 * @returns {void}
 */
export function writeJsonAtomic(filePath, value, options = {}) {
  writeFileAtomic(filePath, `${JSON.stringify(value)}\n`, options);
}
