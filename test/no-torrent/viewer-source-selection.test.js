import assert from "node:assert/strict";
import test from "node:test";
import { Viewers } from "../../services/viewer/Viewers.js";
import { handleApiSourcesPost } from "../../routes/api/sources/post.js";
import { OutputLifecycle } from "../../services/server/OutputLifecycle.js";
import { handleApiPlaybackPlanPost } from "../../routes/api/playback-plan/post.js";
import { handleApiSourceViewerPost } from "../../routes/api/sources/viewer/post.js";

test("source reports move and pause the present viewer without recreating stale selections", async () => {
  let changes = 0;
  const viewers = new Viewers({ onChange: () => changes++ });
  const viewer = viewers.selectsFile("person", "source", 2, 100);
  const reply = { status: 200, code(status) { this.status = status; return this; }, send: value => value };
  const req = { params: { sourceKey: "source", fileIndex: "2" }, body: {
    consumerId: "person", positionSeconds: 123, playing: false, waiting: false, bufferedAheadSec: 8, seek: true
  } };
  assert.deepEqual(await handleApiSourceViewerPost(req, reply,
    { sourceRegistry: { get: () => ({}) }, viewers }), { received: true });
  assert.equal(viewer.positionSeconds(), 123);
  assert.equal(viewer.waiting, false);
  assert.ok(viewer.pausedAt !== null);
  assert.equal(viewer.bufferedSeconds, 8);
  const before = changes;
  viewers.selectsFile("person", "source", 3);
  await handleApiSourceViewerPost(req, reply, { sourceRegistry: { get: () => ({}) }, viewers });
  assert.equal(reply.status, 409);
  assert.equal(changes, before + 1);
  viewer.gone = true;
  assert.equal(viewers.reportSource("person", "source", 3, req.body), false);
  assert.equal(viewers.reportSource("absent", "source", 3, req.body), false);
  assert.equal(viewers.get("absent"), null);
  viewer.gone = false;
  viewer.outputs.add("encoded");
  assert.equal(viewers.reportSource("person", "source", 3, req.body), false);
});

test("a report from before a direct seek cannot restore the previous position", () => {
  const viewers = new Viewers();
  const viewer = viewers.selectsFile("person", "source", 2);
  assert.equal(viewers.reportSource("person", "source", 2,
    { generation: 2, positionSeconds: 300, seek: true, playing: false, waiting: false }), true);
  assert.equal(viewers.reportSource("person", "source", 2,
    { generation: 1, positionSeconds: 100, playing: true }), false);
  assert.equal(viewer.positionSeconds(), 300);
  assert.equal(viewer.playing, false);
});

test("one viewer exists from connection presence through source selection and output changes", () => {
  const viewers = new Viewers();
  const viewer = viewers.present("person", 10);
  assert.equal(viewer.outputs.size, 0);
  assert.equal(viewers.selectsSource("person", "source", 20), viewer);
  assert.equal(viewer.source.sourceKey, "source");
  const first = { id: "first" };
  assert.equal(viewers.of(first, "person", 30), viewer);
  viewers.leaves(first, "person");
  assert.equal(viewers.get("person"), viewer);
  viewers.of({ id: "second" }, "person", 40);
  viewers.outputGone("second");
  assert.equal(viewers.get("person"), viewer);
  viewers.hasGone("person");
  assert.equal(viewers.size, 0);
});

test("registration records a source before any media or torrent is read", async () => {
  const viewers = new Viewers();
  const reply = { send: value => value };
  const result = await handleApiSourcesPost({ body: { sourceType: "torrent", source: "encoded", consumerId: "person" } }, reply,
    { viewers, sourceRegistry: { upsert: async () => "source" } });
  assert.deepEqual(result, { sourceKey: "source", playbackMapVersion: 1 });
  assert.equal(viewers.get("person").source.sourceKey, "source");
  assert.equal(viewers.get("person").outputs.size, 0);
});

test("reselecting the same source retains selection while another source clears it", () => {
  const viewers = new Viewers();
  const viewer = viewers.selectsSource("person", "first");
  viewer.source.selectedFileIndex = 2;
  viewers.selectsSource("person", "first");
  assert.equal(viewer.source.selectedFileIndex, 2);
  viewers.selectsSource("person", "second");
  assert.equal(viewer.source.selectedFileIndex, null);
});

test("connection closure forgets a viewer still preparing source metadata", async () => {
  const viewers = new Viewers();
  viewers.selectsSource("person", "source");
  const lifecycle = new OutputLifecycle({ viewers });
  assert.equal(await lifecycle.viewerHasGone("person"), 0);
  assert.equal(viewers.size, 0);
});

test("the selected source index is recorded before playback metadata is requested", async () => {
  const viewers = new Viewers();
  const reply = { send: value => value };
  await handleApiPlaybackPlanPost({ body: { sourceKey: "source", fileIndex: 7, consumerId: "person" } }, reply,
    { viewers, playbackPlanner: { getPlan: async () => {
      assert.equal(viewers.get("person").source.selectedFileIndex, 7);
      return { pending: true };
    } } });
});

test("visible files use unique source indices and preserve an explicit selection", () => {
  const viewers = new Viewers();
  const viewer = viewers.selectsFile("person", "source", 7);
  assert.equal(viewers.visibleFiles("person", "source", [7, 2, 7]), viewer);
  assert.deepEqual(viewer.source.visibleFileIndices, [7, 2]);
  assert.equal(viewer.source.selectedFileIndex, 7);
  assert.throws(() => viewers.visibleFiles("person", "source", [-1]), /source indices/);
});

test("a new episode resets the previous position and preparation records resume and pause intent", async () => {
  const viewers = new Viewers();
  const viewer = viewers.selectsFile("person", "source", 0, 100);
  viewer.moveTo(600, 100);
  viewers.selectsFile("person", "source", 1, 200);
  assert.equal(viewer.positionSeconds(200), 0);
  await handleApiPlaybackPlanPost({ body: { sourceKey: "source", fileIndex: 2, consumerId: "person",
    positionSeconds: 300, wantsToPlay: false } }, { send: value => value }, {
    viewers, playbackPlanner: { getPlan: async () => {
      assert.equal(viewer.positionSeconds(), 300);
      assert.equal(viewer.playing, false);
      assert.equal(viewer.waiting, false);
      assert.ok(viewer.pausedAt !== null);
      return { mode: "hls" };
    } }
  });
});
