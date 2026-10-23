import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const apt = spawnSync("sudo", ["apt-get", "--print-uris", "--yes", "--no-install-recommends", "install", "ffmpeg"], {
  encoding: "utf8",
});

if (apt.error) throw apt.error;
if (apt.status !== 0) {
  process.stderr.write(apt.stderr);
  process.exit(apt.status ?? 1);
}

const packages = apt.stdout.split(/\r?\n/).flatMap(line => {
  const match = line.match(/^'[^']*'\s+(\S+)\s+(\S+)/);
  return match ? [`${match[1]} ${match[2]}`] : [];
}).sort();

if (packages.length === 0) {
  throw new Error("Could not resolve the packet timing reference packages");
}

const digest = createHash("sha256").update(`${packages.join("\n")}\n`).digest("hex");
const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) throw new Error("GITHUB_OUTPUT is missing");

await appendFile(outputPath, `key=ubuntu-26.04-ffmpeg-${digest}\n`);
