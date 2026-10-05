# Checks that need a real torrent

A check belongs here when it cannot do its job without a real torrent: a WebTorrent
client, the torrent worker thread, a DHT node, a tracker or a swarm.

These checks run **only on the Home Assistant host**. They never run in CI and never on a
development machine (AGENTS.md, "NEVER START A REAL TORRENT LOCALLY"):

1. `npm test` loads only `test/no-torrent/**/*.test.js`, so nothing in this folder is ever
   imported by it.
2. Under `npm test`, `test/no-torrent/support/refuse-torrent.cjs` makes WebTorrent throw on
   construction, so a check that reaches a torrent from `test/no-torrent/` fails instead of
   starting one.
3. `scripts/check-tests-start-no-torrent.mjs` reads `test/no-torrent/` before the tests run
   and refuses a line that would start a torrent.

There is no check here yet. The command that runs this folder is added together with the
first one, and it refuses to start outside the Home Assistant add-on (where the Supervisor
sets `SUPERVISOR_TOKEN`) and runs without the guard of point 2.
