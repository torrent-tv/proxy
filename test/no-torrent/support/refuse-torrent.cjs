// Makes a real torrent impossible while the checks in test/no-torrent/ run (AGENTS.md,
// "NEVER START A REAL TORRENT LOCALLY"). `npm test` loads this with `--require`, so it is in
// force in the process of every test file and in every worker thread one of them creates: a
// worker inherits the parent's execArgv. It is CommonJS and loaded with `--require` rather
// than `--import` because Node runs `--import` in a worker made from a file but not in one
// made from a string of code (`eval: true`), and `--require` in both (Node 24.2, measured).
//
// Every torrent this proxy runs begins with `new WebTorrent`: TorrentPool is the only place
// that constructs one, and the torrent worker thread builds a TorrentPool. So WebTorrent is
// replaced by a class whose constructor throws, and a check that reaches it by any chain of
// calls fails instead of joining a swarm. Importing torrent-pool.js and calling its prototype
// methods on a fake stays possible, and so does a module inside the library
// (`webtorrent/lib/selections.js` is a list of piece ranges); a client cannot be built from
// one without the class. The packages that run a DHT node, a tracker client or
// local peer discovery on their own are refused at import: no check has a reason to load them.
//
// scripts/check-tests-start-no-torrent.mjs is the other half: it reads the checks before they
// run and names the line that would have tried.
const { registerHooks } = require("node:module");

const REFUSAL = "a check in test/no-torrent/ tried to start a real torrent";

// The static member is on the replacement class only, so a check can tell it from the library
// before constructing it (test/no-torrent/refuse-torrent.test.js).
const REFUSING_CLASS = `export default class WebTorrent {
  static [Symbol.for("torrent-tv.refused-torrent")] = true;
  constructor() { throw new Error(${JSON.stringify(REFUSAL)}); }
}`;

const REFUSED_PACKAGES = new Set(["bittorrent-dht", "bittorrent-tracker", "bittorrent-lsd", "torrent-discovery"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "webtorrent") {
      return { url: `data:text/javascript,${encodeURIComponent(REFUSING_CLASS)}`, format: "module", shortCircuit: true };
    }
    if (REFUSED_PACKAGES.has(specifier.split("/")[0])) {
      throw new Error(`${REFUSAL}: it imported ${specifier}`);
    }
    return nextResolve(specifier, context);
  }
});
