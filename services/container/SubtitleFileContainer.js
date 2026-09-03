/**
 * @file A file of subtitles as a container of its own — `.srt`, `.ass`, `.ssa`,
 * `.vtt` shipped beside the film.
 *
 * It belongs in this folder for the same reason `.mka` does: "a file of its
 * own" is not a KIND of track, only the answer to where a track's bytes are,
 * and the question this folder answers is how a format frames what it carries.
 * SubRip frames a cue as an ordinal, a timing line and the lines under it; ASS
 * frames one as a `Dialogue:` row whose FIELD ORDER the file itself states in
 * `[Events]`; WebVTT is already what a browser reads.
 *
 * That last point about ASS is what makes the file different from Matroska and
 * the reason both need their own answer. Matroska fixes the order in its own
 * specification, so eight fields always stand before the text. A file does not:
 * `Format:` may list the columns in any order, and the specification is that
 * the reader obeys it. Two framings of one subtitle format, each stated by
 * whoever stores it.
 *
 * What this file does NOT do is take off ASS's own markup — `{\pos(…)}`, `\N`,
 * `\h`. That is the same wherever ASS is stored and lives in
 * `tracks/subtitle-markup.js`.
 */

import { Container } from "./Container.js";
import { TextSubtitleTrack } from "../tracks/TextSubtitleTrack.js";

/** The extensions this reads. `.vtt` is included and passes through unparsed. */
const EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt", ".webvtt"]);

/**
 * A SubRip timing line. The specification writes a comma before the
 * milliseconds; WebVTT writes a dot, which is the only difference between the
 * two lines.
 */
const SRT_TIMING = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/** An ASS timing field: `h:mm:ss.cc`, centiseconds. */
const ASS_TIMING = /^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$/;

/**
 * Seconds from a SubRip timing line's four captured parts.
 *
 * @param {string[]} parts - [hours, minutes, seconds, fraction]
 * @returns {number}
 */
function srtSeconds([hours, minutes, seconds, fraction]) {
  const ms = Number(String(fraction).padEnd(3, "0"));
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + ms / 1000;
}

/**
 * Seconds from an ASS timing field.
 *
 * @param {string} field
 * @returns {number | null} Null when the field is not a timing at all, which is
 *   a malformed row and not a cue at zero.
 */
function assSeconds(field) {
  const match = ASS_TIMING.exec(String(field ?? "").trim());
  if (!match) {
    return null;
  }
  const centiseconds = Number(String(match[4]).padEnd(2, "0"));
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + centiseconds / 100;
}

export class SubtitleFileContainer extends Container {
  /**
   * @param {object} params
   * @param {string} params.extension - Lowercase, including the dot.
   * @param {string} [params.label]
   */
  constructor({ extension, label = "" }) {
    // A subtitle file is read whole — it is kilobytes — so there is no range
    // reading and no size to bound it by. `readTracks` and `readCues` take the
    // decoded text directly, which is why the base's `readRange` is unused.
    super({ readRange: null, fileSize: 0, label });
    this.extension = String(extension ?? "").toLowerCase();
    /** Column order from `[Events]`'s `Format:`, once a file has been read. */
    this.eventColumns = null;
  }

  get formatName() {
    return "subtitle-file";
  }

  /**
   * @param {string} extension - Lowercase, including the dot.
   * @returns {boolean}
   */
  static detect(extension) {
    return EXTENSIONS.has(String(extension ?? "").toLowerCase());
  }

  /**
   * The single track a subtitle file carries.
   *
   * Its `codecId` is the extension, which is the only thing the file says about
   * its own format, and `subtitle-markup.js` accepts extensions alongside
   * container codec names for exactly this reason.
   *
   * @returns {Promise<TextSubtitleTrack[]>}
   */
  async readTracks() {
    return [new TextSubtitleTrack({
      trackNumber: 0,
      declaredIndex: 0,
      codecId: this.extension,
      language: "",
      languageBcp47: "",
      name: this.label,
      isEnabled: true,
      isDefault: false,
      declaresDefault: false
    })];
  }

  /**
   * The text field of one ASS `Dialogue:` row, by the order the file declared.
   *
   * Not static, unlike the other containers': the order is read out of the
   * file's own header, so the answer depends on which file this is. A row
   * arriving before any `Format:` line has been seen has no declared order and
   * is not guessed at.
   *
   * @param {string} row - The row after `Dialogue:`.
   * @param {string} [codecId]
   * @returns {string}
   */
  cueTextOf(row, codecId = this.extension) {
    if (codecId !== ".ass" && codecId !== ".ssa") {
      return String(row ?? "");
    }
    const at = this.eventColumns ? this.eventColumns.indexOf("text") : -1;
    if (at < 0) {
      return "";
    }
    // The text field is last by the specification and may hold commas, so
    // everything from its column on is joined back together.
    return String(row ?? "").split(",").slice(at).join(",");
  }

  /**
   * Every cue in the file, with its markup still in place.
   *
   * @param {string} text - The file, already decoded to characters.
   * @returns {{ startSeconds: number, endSeconds: number, text: string }[] | null}
   *   Null for WebVTT, which is not parsed: it is already what a browser reads,
   *   and taking it apart to write it back would drop its styles, its regions
   *   and its cue identifiers for nothing.
   */
  readCues(text) {
    const lines = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (this.extension === ".ass" || this.extension === ".ssa") {
      return this.#assCues(lines);
    }
    if (this.extension === ".srt") {
      return this.#srtCues(lines);
    }
    return null;
  }

  /**
   * @param {string[]} lines
   * @returns {{ startSeconds: number, endSeconds: number, text: string }[]}
   */
  #assCues(lines) {
    const cues = [];
    let inEvents = false;
    this.eventColumns = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\[.*\]$/.test(trimmed)) {
        inEvents = trimmed === "[Events]";
        continue;
      }
      if (!inEvents) {
        continue;
      }
      if (trimmed.startsWith("Format:")) {
        this.eventColumns = trimmed
          .slice("Format:".length)
          .split(",")
          .map((column) => column.trim().toLowerCase());
        continue;
      }
      if (!trimmed.startsWith("Dialogue:") || !this.eventColumns) {
        continue;
      }
      const row = trimmed.slice("Dialogue:".length);
      const fields = row.split(",");
      const startAt = this.eventColumns.indexOf("start");
      const endAt = this.eventColumns.indexOf("end");
      if (startAt < 0 || endAt < 0) {
        continue;
      }
      const startSeconds = assSeconds(fields[startAt]);
      const endSeconds = assSeconds(fields[endAt]);
      const cueText = this.cueTextOf(row);
      if (startSeconds === null || endSeconds === null || !cueText) {
        continue;
      }
      cues.push({ startSeconds, endSeconds, text: cueText });
    }
    return cues;
  }

  /**
   * @param {string[]} lines
   * @returns {{ startSeconds: number, endSeconds: number, text: string }[]}
   */
  #srtCues(lines) {
    const cues = [];
    /** @type {{ startSeconds: number, endSeconds: number, text: string[] } | null} */
    let open = null;
    const close = () => {
      if (!open) {
        return;
      }
      // A file with no blank line between cues leaves the next cue's ordinal as
      // the last line of this one. It is SubRip's own numbering, never
      // dialogue, so it goes rather than being shown.
      while (open.text.length > 0 && /^\d+$/.test(open.text[open.text.length - 1].trim())) {
        open.text.pop();
      }
      const text = open.text.join("\n").trim();
      if (text) {
        cues.push({ startSeconds: open.startSeconds, endSeconds: open.endSeconds, text });
      }
      open = null;
    };
    for (const line of lines) {
      const timing = SRT_TIMING.exec(line.trim());
      if (timing) {
        // A timing line opens a cue and closes the one before it. The ordinal
        // above it is SubRip's own numbering and carries nothing a player needs,
        // so it is dropped rather than carried into the cue's text — which is
        // what taking the lines between timings would do.
        close();
        open = {
          startSeconds: srtSeconds(timing.slice(1, 5)),
          endSeconds: srtSeconds(timing.slice(5, 9)),
          text: []
        };
        continue;
      }
      if (!open) {
        continue;
      }
      if (line.trim() === "") {
        close();
        continue;
      }
      open.text.push(line);
    }
    close();
    return cues;
  }
}

export { EXTENSIONS as SUBTITLE_FILE_EXTENSIONS };
