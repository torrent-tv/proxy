/**
 * @file The browser's log, written beside the proxy's.
 *
 * What these hold is the naming, because the name is the whole point: the two
 * halves of a session have to join without guessing, and a torrent name is
 * arbitrary bytes chosen by a stranger that is about to become a path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClientLogConsole, createClientLogFiles } from "../utils/client-log-file.js";

/** A directory with a proxy log in it, which is what the sink is given. */
function aDirectory() {
  const dir = mkdtempSync(join(tmpdir(), "ttv-client-log-"));
  return { dir, proxyLog: join(dir, "proxy.log") };
}

const aSession = (over = {}) => ({
  sessionId: "abcd1234",
  startedAt: "2026-09-13T16:05:24.123Z",
  torrentName: "Reacher.S04E07.1080p.rus.LostFilm.TV.mkv",
  infoHash: "94dda59fdf252447d6ca5a8775dab2d11a832da5",
  ...over
});

test("the file lands beside the proxy log, named by when it started and what is watched", async () => {
  const { dir, proxyLog } = aDirectory();
  const logs = createClientLogFiles(proxyLog);
  logs.write(aSession(), ["first line"]);
  await logs.close();

  const [name] = readdirSync(dir).filter((f) => f.startsWith("client-"));
  assert.ok(name, "a client log file was written");
  // The stamp is UTC and sorts; the session id joins it to the proxy's lines;
  // the film says which one it is without opening the file.
  assert.match(name, /^client-20260913-160524-abcd1234-Reacher\.S04E07\.1080p\.rus\.LostFilm\.TV\.mkv-94dda59f\.log$/);
  assert.equal(readFileSync(join(dir, name), "utf8"), "first line\n");
});

test("lines from one session go on appending to the one file", async () => {
  const { dir, proxyLog } = aDirectory();
  const logs = createClientLogFiles(proxyLog);
  logs.write(aSession(), ["one", "two"]);
  logs.write(aSession(), ["three"]);
  await logs.close();

  const names = readdirSync(dir).filter((f) => f.startsWith("client-"));
  assert.equal(names.length, 1);
  assert.equal(readFileSync(join(dir, names[0]), "utf8"), "one\ntwo\nthree\n");
});

test("a session that has not chosen a film yet still gets its own file", async () => {
  // The page opening, a proxy being chosen, a connection failing — all before
  // any torrent exists, and all worth keeping.
  const { dir, proxyLog } = aDirectory();
  const logs = createClientLogFiles(proxyLog);
  logs.write(aSession({ torrentName: "", infoHash: "" }), ["before any film"]);
  await logs.close();

  const [name] = readdirSync(dir).filter((f) => f.startsWith("client-"));
  assert.match(name, /-no-torrent-yet\.log$/);
});

test("the file is renamed after the film when one is chosen, and keeps the earlier lines", async () => {
  // The first batch always comes before a torrent is chosen. Keyed by the
  // session, the file is not a second one when the film arrives; it gains the
  // film's name, so the log can be found by the film it played.
  const { dir, proxyLog } = aDirectory();
  const logs = createClientLogFiles(proxyLog);
  logs.write(aSession({ torrentName: "", infoHash: "" }), ["before"]);
  logs.write(aSession(), ["after"]);
  logs.write(aSession({ torrentName: "", infoHash: "" }), ["a batch that names nothing"]);
  await logs.close();

  const names = readdirSync(dir).filter((f) => f.startsWith("client-"));
  assert.deepEqual(names, ["client-20260913-160524-abcd1234-Reacher.S04E07.1080p.rus.LostFilm.TV.mkv-94dda59f.log"]);
  assert.equal(readFileSync(join(dir, names[0]), "utf8"), "before\nafter\na batch that names nothing\n");
});

test("another torrent in the same page starts its own file under the same prefix", async () => {
  // Renaming again would put the first film's lines under the second film's
  // name, where nobody looking for the first film finds them.
  const { dir, proxyLog } = aDirectory();
  const logs = createClientLogFiles(proxyLog);
  logs.write(aSession(), ["first film"]);
  logs.write(aSession({ torrentName: "Drifters", infoHash: "0123456789abcdef0123456789abcdef01234567" }), ["second film"]);
  await logs.close();

  const names = readdirSync(dir).filter((f) => f.startsWith("client-")).sort();
  assert.deepEqual(names, [
    "client-20260913-160524-abcd1234-Drifters-01234567.log",
    "client-20260913-160524-abcd1234-Reacher.S04E07.1080p.rus.LostFilm.TV.mkv-94dda59f.log"
  ]);
  assert.equal(readFileSync(join(dir, names[0]), "utf8"), "second film\n");
  assert.equal(readFileSync(join(dir, names[1]), "utf8"), "first film\n");
});

test("the same torrent named again changes nothing", async () => {
  const { dir, proxyLog } = aDirectory();
  const logs = createClientLogFiles(proxyLog);
  logs.write(aSession(), ["one"]);
  logs.write(aSession(), ["two"]);
  await logs.close();

  const names = readdirSync(dir).filter((f) => f.startsWith("client-"));
  assert.equal(names.length, 1);
  assert.equal(readFileSync(join(dir, names[0]), "utf8"), "one\ntwo\n");
});

test("a hostile torrent name cannot escape the directory when the file is renamed", async () => {
  const { dir, proxyLog } = aDirectory();
  const logs = createClientLogFiles(proxyLog);
  logs.write(aSession({ torrentName: "", infoHash: "" }), ["before"]);
  logs.write(aSession({ torrentName: "../../etc/passwd", infoHash: "../.." }), ["after"]);
  await logs.close();

  const names = readdirSync(dir).filter((f) => f.startsWith("client-"));
  assert.equal(names.length, 1);
  assert.ok(!names[0].includes(".."), `no traversal in ${names[0]}`);
  assert.equal(readFileSync(join(dir, names[0]), "utf8"), "before\nafter\n");
});

test("a hostile torrent name cannot escape the directory", async () => {
  const { dir, proxyLog } = aDirectory();
  const logs = createClientLogFiles(proxyLog);
  logs.write(aSession({ torrentName: "../../etc/passwd" }), ["x"]);
  await logs.close();

  const names = readdirSync(dir).filter((f) => f.startsWith("client-"));
  assert.equal(names.length, 1);
  assert.ok(!names[0].includes(".."), `no traversal in ${names[0]}`);
  assert.ok(!names[0].includes("/"), `no separator in ${names[0]}`);
});

test("a full file is rotated, and the next batch starts a fresh one under the name", async () => {
  // The next batch arrives while the rotated file may still be flushing; it
  // must not append to the file being moved.
  const { dir, proxyLog } = aDirectory();
  const logs = createClientLogFiles(proxyLog);
  const big = "x".repeat(16 * 1024 * 1024);
  logs.write(aSession(), [big]);
  logs.write(aSession(), ["after rotation"]);
  await logs.close();

  const base = "client-20260913-160524-abcd1234-Reacher.S04E07.1080p.rus.LostFilm.TV.mkv-94dda59f.log";
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("client-")).sort(), [base, `${base}.1`]);
  assert.equal(readFileSync(join(dir, `${base}.1`), "utf8").length, big.length + 1);
  assert.equal(readFileSync(join(dir, base), "utf8"), "after rotation\n");
});

test("two sessions of one film are two files", async () => {
  const { dir, proxyLog } = aDirectory();
  const logs = createClientLogFiles(proxyLog);
  logs.write(aSession({ sessionId: "aaaa1111" }), ["one viewer"]);
  logs.write(aSession({ sessionId: "bbbb2222", startedAt: "2026-09-13T16:07:11.000Z" }), ["another"]);
  await logs.close();

  assert.equal(readdirSync(dir).filter((f) => f.startsWith("client-")).length, 2);
});

test("no proxy log path means nothing is written and nothing throws", async () => {
  const logs = createClientLogFiles("");
  logs.write(aSession(), ["dropped"]);
  await logs.close();
});

test("without a log file the lines go to the console, each naming its session", async () => {
  // A proxy started from npm or Docker names no file; the browser's half of
  // the viewing must still reach the output the host keeps.
  const printed = [];
  const logs = createClientLogConsole((message) => printed.push(message));
  logs.write(aSession(), ["first line", "second line"]);
  logs.write(aSession({ sessionId: "" }), ["no id"]);
  await logs.close();

  assert.deepEqual(printed, [
    "client abcd1234 first line",
    "client abcd1234 second line",
    "client unknown no id"
  ]);
});
