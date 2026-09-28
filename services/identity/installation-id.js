import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const ID_FILE = "proxy-identity.json";

/**
 * Resolve this installation's registry id. Without a state directory the id
 * remains ephemeral; with one, the id survives process restarts.
 *
 * @param {{ stateDir?: string, explicitId?: string, makeId?: () => string }} options
 * @returns {string}
 */
export function installationId({ stateDir, explicitId, makeId = randomUUID } = {}) {
  const requestedId = typeof explicitId === "string" ? explicitId.trim() : "";
  if (!stateDir) {
    return requestedId || makeId();
  }

  const file = path.join(stateDir, ID_FILE);
  let savedId = "";
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    savedId = typeof saved?.id === "string" ? saved.id.trim() : "";
    if (!savedId) {
      throw new Error(`Invalid proxy identity file: ${file}`);
    }
  }

  const id = requestedId || savedId || makeId();
  if (id !== savedId) {
    mkdirSync(stateDir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ id })}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }
  return id;
}
