// Refuses any check in test/no-torrent/ that could start a real torrent. Those checks run in
// CI and locally, so they must never reach a torrent (AGENTS.md, "NEVER START A REAL TORRENT
// LOCALLY"). Checks that need a real torrent live in test/with-torrent/, which nothing here
// reads and `npm test` never loads; they run only on the Home Assistant host.
//
// This is the static half of the rule, run before the tests: it names the line. The other
// half is test/no-torrent/support/refuse-torrent.cjs, loaded by `npm test`, which makes
// WebTorrent throw on construction however a check reaches it.
//
// What starts a torrent: constructing TorrentPool (the only `new WebTorrent`), the
// TorrentWorkerClient or the torrent worker thread, importing WebTorrent itself, or starting
// the proxy's entry point. Calling TorrentPool prototype methods on a fake, and giving
// WorkerTorrentPool a fake client, start nothing and stay allowed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const FORBIDDEN = [
  [/\bnew\s+TorrentPool\s*\(/, "constructs TorrentPool, which creates a WebTorrent client"],
  [/\bnew\s+WebTorrent\s*\(/, "constructs a WebTorrent client"],
  [/\bnew\s+TorrentWorkerClient\s*\(/, "constructs the torrent worker client, which starts the torrent thread"],
  [/from\s+["']webtorrent["']|import\(\s*["']webtorrent["']\s*\)|require\(\s*["']webtorrent["']\s*\)/, "imports WebTorrent"],
  [/worker\/worker\.js/, "names the torrent worker thread"],
  [/bin\/cli\.js/, "names the proxy entry point"],
];

// The check of the guard itself names WebTorrent on purpose, and constructs it only after
// confirming that the module loaded is the refusing class.
const ALLOWED = new Set(["test/no-torrent/refuse-torrent.test.js"]);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(c|m)?js$/.test(name)) yield path;
  }
}

let found = 0;
for (const file of files("test/no-torrent")) {
  if (ALLOWED.has(relative(".", file).split("\\").join("/"))) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const [pattern, reason] of FORBIDDEN) {
      if (!pattern.test(line)) continue;
      found += 1;
      console.log(`::error file=${relative(".", file)},line=${index + 1}::${reason}; checks must use a fake instead`);
    }
  });
}
if (found) process.exitCode = 1;
else console.log("no check in test/no-torrent/ constructs a torrent client, the torrent thread or the proxy entry point");
