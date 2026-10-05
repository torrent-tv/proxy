import test from "node:test";
import assert from "node:assert/strict";
import { handleApiSubtitlesPost } from "../../routes/api/subtitles/post.js";
import { Viewers } from "../../services/viewer/Viewers.js";

test("subtitle choice rejects unrelated sidecars and obsolete embedded tracks", async () => {
  const viewers = new Viewers();
  viewers.selectsFile("viewer", "source", 0);
  const deps = { viewers, sourceRegistry: { get: () => ({}) }, subtitleFilesFor: () => [1],
    subtitleTracksFor: () => [{ declaredIndex: 0, isTextBased: () => true }, { declaredIndex: 1, isTextBased: () => false }] };
  const reply = { status: 200, code(status) { this.status = status; return this; }, send(body) { return body; } };
  const request = (fileIndex, trackIndex = null, extra = {}) => ({ body: {
    sourceKey: "source", consumerId: "viewer", fileIndex, trackIndex, ...extra } });
  assert.equal((await handleApiSubtitlesPost(request(1), reply, deps)).received, true);
  assert.equal(viewers.get("viewer").subtitle.fileIndex, 1);
  await handleApiSubtitlesPost(request(2), reply, deps);
  assert.equal(reply.status, 409);
  assert.equal(viewers.get("viewer").subtitle.fileIndex, 1);
  await handleApiSubtitlesPost(request(1, 0), reply, deps);
  assert.equal(reply.status, 409);
  assert.equal((await handleApiSubtitlesPost(request(0, 0), reply, deps)).received, true);
  assert.equal(viewers.get("viewer").subtitle.trackIndex, 0);
  await handleApiSubtitlesPost(request(0, 1), reply, deps);
  assert.equal(reply.status, 422);
  await handleApiSubtitlesPost(request(0, 2), reply, deps);
  assert.equal(reply.status, 422);
  assert.equal(viewers.get("viewer").subtitle.trackIndex, 0);
  assert.equal((await handleApiSubtitlesPost(request(0, null, { off: true }), reply, deps)).received, true);
  assert.equal(viewers.get("viewer").subtitle, null);
  viewers.hasGone("viewer");
  await handleApiSubtitlesPost(request(0, 0), reply, deps);
  assert.equal(reply.status, 409);
  assert.equal(viewers.size, 0);
});
