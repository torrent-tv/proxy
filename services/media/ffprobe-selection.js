/**
 * @file Which ffprobe binary the proxy probes with is decided once, at startup,
 * by what the binary can do: its `-sections` output names the section
 * `stream_side_data`, which the `streams` statement of `probe-packets.js` asks for.
 * The bundled build of darwin-arm64 (4.4.1) has `stream_side_data_list` and no
 * `stream_side_data`, and refuses every probe; a version number would need a table
 * of releases, the section list is the fact.
 */

/** The section the `streams` statement asks for. */
const REQUIRED_SECTION = "stream_side_data";

/** Thrown when no candidate qualifies; its message is the one line `selectFfprobe` logged. */
export class FfprobeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "FfprobeUnavailableError";
  }
}

/**
 * The candidates in order of preference: the bundled binary when its path is
 * known, then `ffprobe` found on PATH.
 *
 * @param {{ bundledBinary?: string | null }} options
 * @returns {{ source: "bundled" | "PATH", binary: string }[]}
 */
export function ffprobeCandidates({ bundledBinary }) {
  const candidates = [];
  if (typeof bundledBinary === "string" && bundledBinary !== "") candidates.push({ source: "bundled", binary: bundledBinary });
  candidates.push({ source: "PATH", binary: "ffprobe" });
  return candidates;
}

/** The word after `ffprobe version` on the first line, or "unknown". */
function versionOf(output) {
  return /^ffprobe version (\S+)/.exec(String(output).split("\n", 1)[0])?.[1] ?? "unknown";
}

/** True when a name in the `-sections` print, taken apart at whitespace and `/`, equals the section. */
function namesSection(output) {
  return String(output).split(/[\s/]+/).includes(REQUIRED_SECTION);
}

/**
 * Ask each candidate, in order, its version and its sections, each at most once, and
 * choose the first that exits 0 from `-sections` and names `stream_side_data`. A later
 * candidate is not run once one is chosen.
 *
 * @param {object} options
 * @param {{ source: string, binary: string }[]} options.candidates
 * @param {(binary: string, args: string[]) => Promise<{ status: number | null, stdout: string, stderr: string }>} options.run
 *   Rejects when the process cannot be started.
 * @param {{ error: (line: string) => void }} options.logger
 * @returns {Promise<{ source: string, binary: string, version: string }>}
 * @throws {FfprobeUnavailableError} After one `error` line, when no candidate qualifies.
 */
export async function selectFfprobe({ candidates, run, logger }) {
  const entries = [];
  for (const { source, binary } of candidates) {
    let version;
    let sections;
    try {
      const versionRun = await run(binary, ["-version"]);
      version = versionRun.status === 0 ? versionOf(versionRun.stdout) : "unknown";
      sections = await run(binary, ["-hide_banner", "-sections"]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      entries.push(`${source} ${binary} cannot be run (${reason}), so ${REQUIRED_SECTION} was not checked`);
      continue;
    }
    if (sections.status === 0 && namesSection(sections.stdout)) return { source, binary, version };
    const exit = sections.status === 0 ? "" : `, -sections exited ${sections.status}`;
    entries.push(`${source} ${binary} (version ${version}${exit}) lacks section ${REQUIRED_SECTION}`);
  }
  const line = `ffprobe: no usable binary: ${entries.length ? entries.join("; ") : "no candidate to try"}`;
  logger.error(line);
  throw new FfprobeUnavailableError(line);
}
