/**
 * @file Who wants subtitle cues, and why the answer is a person and not a channel.
 *
 * The subscription used to be a `Set<DataChannel>` inside the transport, keyed
 * by `sourceKey:fileIndex`. Two things followed from that, and both are field
 * facts rather than worries:
 *
 * 1. a seamless reconnect lost subtitles for the rest of the session, because
 *    the new channel is a different object and nothing re-subscribed it;
 * 2. the transport had to sniff `/api/subtitles` out of the request path and
 *    derive a torrent key to build that key at all — application routing and
 *    torrent identity, inside the layer that is only supposed to carry bytes.
 *
 * Held against the viewer instead, both go away by construction: whatever
 * channel the person is reachable on next, they are still subscribed, and the
 * transport never learns what a subtitle is.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Viewers } from "../services/viewer/Viewers.js";

/** An output is only ever held by id here, so the thinnest possible stand-in. */
const anOutput = (id) => ({ id, viewers: new Set() });

test("a viewer who switched subtitles on is listed for that file", () => {
  const viewers = new Viewers();
  viewers.of(anOutput("picture"), "alice");

  assert.equal(viewers.wantsCues("alice", "src-1", 3), true);
  assert.deepEqual(viewers.wantingCues("src-1", 3), ["alice"]);
});

test("nobody is listed for a file nobody asked about", () => {
  const viewers = new Viewers();
  viewers.of(anOutput("picture"), "alice");
  viewers.wantsCues("alice", "src-1", 3);

  assert.deepEqual(viewers.wantingCues("src-1", 4), []);
  assert.deepEqual(viewers.wantingCues("src-2", 3), []);
});

test("two viewers of one file are both listed, and one file each is kept apart", () => {
  const viewers = new Viewers();
  const picture = anOutput("picture");
  viewers.of(picture, "alice");
  viewers.of(picture, "bob");

  viewers.wantsCues("alice", "src-1", 0);
  viewers.wantsCues("bob", "src-1", 0);
  viewers.wantsCues("bob", "src-1", 1);

  assert.deepEqual(viewers.wantingCues("src-1", 0).sort(), ["alice", "bob"]);
  assert.deepEqual(viewers.wantingCues("src-1", 1), ["bob"]);
});

test("the subscription outlives the connection, which is the whole point", () => {
  // Nothing here mentions a channel, and that is the assertion: the registry
  // has no way to express "this channel", so a channel dying cannot take a
  // subscription with it.
  const viewers = new Viewers();
  viewers.of(anOutput("picture"), "alice");
  viewers.wantsCues("alice", "src-1", 3);

  // A reconnect is, from here, nothing at all: the same person is still known.
  viewers.seen("alice");

  assert.deepEqual(viewers.wantingCues("src-1", 3), ["alice"]);
});

test("a viewer who has gone is no longer listed", () => {
  const viewers = new Viewers();
  const picture = anOutput("picture");
  viewers.of(picture, "alice");
  viewers.wantsCues("alice", "src-1", 3);

  viewers.hasGone("alice", (id) => (id === "picture" ? picture : null));

  assert.deepEqual(viewers.wantingCues("src-1", 3), []);
});

test("an unknown name subscribes to nothing", () => {
  const viewers = new Viewers();
  assert.equal(viewers.wantsCues("nobody", "src-1", 3), false);
  assert.deepEqual(viewers.wantingCues("src-1", 3), []);
});

test("a request missing the file index registers nothing", () => {
  const viewers = new Viewers();
  viewers.of(anOutput("picture"), "alice");

  assert.equal(viewers.wantsCues("alice", "src-1", Number.NaN), false);
  assert.equal(viewers.wantsCues("alice", "", 3), false);
  assert.deepEqual(viewers.wantingCues("src-1", 3), []);
});
