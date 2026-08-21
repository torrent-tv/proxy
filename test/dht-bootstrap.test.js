/**
 * @file The DHT's entry points are given as addresses, not names.
 *
 * Measured 2026-08-21 on the addon host. Two of the three bootstrap nodes the
 * library ships answer nothing: `router.bittorrent.com` and `router.utorrent.com`
 * did not reply to a hand-written `ping` at all, while a control datagram to a
 * DNS server came back in 20 ms. The third, `dht.transmissionbt.com`, is alive —
 * it answered `find_node` with eight nodes — but on a host with global IPv6 its
 * name resolves to an IPv6 address first, and the DHT's socket is IPv4, so by
 * name it was never reached. By name: 0 nodes after 21 s, every run. By address:
 * 22 nodes in 5 s.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { dhtNodeCount, parseBootstrapEntry, resolveDhtBootstrap } from "../services/torrent-pool.js";

test("a bootstrap entry is split into host and port", () => {
  assert.deepEqual(parseBootstrapEntry("dht.libtorrent.org:25401"), {
    host: "dht.libtorrent.org",
    port: 25401
  });
});

test("an entry with no port gets the DHT's own", () => {
  assert.deepEqual(parseBootstrapEntry("router.bittorrent.com"), {
    host: "router.bittorrent.com",
    port: 6881
  });
});

test("an unusable entry is dropped rather than breaking the client", () => {
  // One bad line in the list must cost that node and nothing else — the DHT is
  // best-effort by nature and a typo here would otherwise take the whole client
  // down at construction.
  assert.equal(parseBootstrapEntry(""), null);
  assert.equal(parseBootstrapEntry("   "), null);
  assert.equal(parseBootstrapEntry("host:0"), null);
  assert.equal(parseBootstrapEntry("host:70000"), null);
  assert.equal(parseBootstrapEntry("host:not-a-port"), null);
  assert.equal(parseBootstrapEntry(":6881"), null);
  assert.equal(parseBootstrapEntry(null), null);
  assert.equal(parseBootstrapEntry(42), null);
});

test("the routing table's size is readable, and its absence is not an error", () => {
  assert.equal(dhtNodeCount({ dht: { nodes: { toArray: () => [1, 2, 3] } } }), 3);
  assert.equal(dhtNodeCount({ dht: { nodes: { toArray: () => [] } } }), 0);
  // A client built without a DHT, or one whose internals moved: the difference
  // between "no DHT" and "an empty DHT" is the whole point of the report, so
  // the first must not be printed as the second.
  assert.equal(dhtNodeCount({}), null);
  assert.equal(dhtNodeCount({ dht: {} }), null);
  assert.equal(dhtNodeCount(null), null);
  assert.equal(dhtNodeCount({ dht: { nodes: { toArray: () => { throw new Error("gone"); } } } }), null);
});

test("a name that will not resolve inside the cap is dropped, not waited on", async () => {
  // The whole call is awaited before the torrent client exists, so a resolver
  // that black-holes must cost the cap and not c-ares' own four tries.
  const started = Date.now();
  // `.invalid` is reserved by RFC 2606 and never resolves; the cap is what
  // bounds the wait when a resolver answers slowly rather than quickly.
  const resolved = await resolveDhtBootstrap(["nothing.invalid:6881"], 200);
  assert.deepEqual(resolved, []);
  assert.ok(Date.now() - started < 2000, "the cap, not the resolver, decided when to give up");
});

test("an empty list is an answer, not a failure", async () => {
  assert.deepEqual(await resolveDhtBootstrap([], 200), []);
});
