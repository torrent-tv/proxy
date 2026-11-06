/**
 * @file The once-per-file line that says what a file's work tags read.
 *
 * Moved out of `server.js` verbatim (torrent-tv/meta#280).
 */

import { describeWorkTags } from "./ContainerOrchestrator.js";

export class WorkTagsReport {
  #logged = new Set();
  #log;

  /** @param {{ log: (line: string) => void }} ports */
  constructor({ log }) {
    this.#log = log;
  }

  /**
   * @param {{ sourceKey: string, fileIndex: number }} address
   * @param {string} label
   * @param {{ kind: string }} result
   */
  note({ sourceKey, fileIndex }, label, result) {
    const key = `${sourceKey}:${fileIndex}`;
    if (result.kind !== "pending" && result.kind !== "needs-ranges" && !this.#logged.has(key)) {
      this.#logged.add(key);
      this.#log(`container metadata "${label}": ${describeWorkTags(result)}`);
    }
  }
}
