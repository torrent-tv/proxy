import test from "node:test";
import assert from "node:assert/strict";
import { Viewers } from "../../services/viewer/Viewers.js";
import { PriorityOrchestrator } from "../../services/viewer/PriorityOrchestrator.js";
import { runsOf } from "../../services/viewer/PriorityMap.js";
import { recordViewerReport } from "../../services/viewer/report-intake.js";
import { ViewerRequests } from "../../services/server/ViewerRequests.js";
import { OutputLifecycle } from "../../services/server/OutputLifecycle.js";
import { handleApiSourcesPost } from "../../routes/api/sources/post.js";
import { chooseAudioTrack, noteStepOnScreen, noteStepBeingWarmed, noteAudioBeingWarmed,
  watches, placeOn } from "../../services/viewer/choices.js";

function viewing() {
  const base = { id: "picture", outputKey: "picture-key",
    file: { sourceKey: "source", fileIndex: 0, durationSeconds: 600 } };
  const audio = { id: "audio", outputKey: "audio-key", file: base.file };
  const viewers = new Viewers();
  const published = [];
  const priority = new PriorityOrchestrator({ viewers, publish: map => published.push(map) });
  const publish = () => priority.publishFor({ sessionGroups: [[base, audio]] });
  viewers.of(base, "person").moveTo(100);
  publish();
  return { base, audio, viewers, published, priority, publish };
}

test("a report arriving after departure cannot restore the file's map", () => {
  const { base, viewers, published, publish } = viewing();
  viewers.hasGone("person");
  publish();
  assert.deepEqual(published.at(-1).zones, []);

  const recorded = recordViewerReport({ outputs: new Map([[base.id, base]]), viewers,
    sessionId: base.id, report: { consumerId: "person", positionSeconds: 100, playing: true } });
  publish();
  assert.equal(recorded, false);
  assert.equal(viewers.get("person"), null);
  assert.deepEqual(published.at(-1).zones, []);
});

test("metadata completing after departure or source replacement cannot restore source demand", () => {
  const viewers = new Viewers();
  viewers.selectsSource("person", "source");
  viewers.hasGone("person");
  assert.equal(viewers.visibleFiles("person", "source", [0]), null);
  assert.equal(viewers.get("person"), null);
  const returned = viewers.selectsSource("person", "new-source");
  assert.equal(viewers.visibleFiles("person", "source", [0]), null);
  assert.equal(returned.source.sourceKey, "new-source");
});

test("source registration completing after departure does not restore presence", async () => {
  const viewers = new Viewers();
  let complete;
  const pending = handleApiSourcesPost({ body: { sourceType: "magnet", source: "source", consumerId: "person" } },
    { send: value => value }, { viewers,
      sourceRegistry: { upsert: () => new Promise(resolve => { complete = resolve; }) } });
  assert.ok(viewers.get("person"));
  viewers.hasGone("person");
  complete("source");
  await pending;
  assert.equal(viewers.get("person"), null);
});

test("an audio opening completing after departure cannot register a new viewer", async () => {
  const { base, audio, viewers, published, priority, publish } = viewing();
  const requests = new ViewerRequests({ viewers, planEncodersSoon() {} });
  let complete;
  const opening = new Promise(resolve => { complete = resolve; });
  const pending = opening.then(output => requests.placeViewerOn(output, "person", 100));
  viewers.hasGone("person");
  publish();
  complete(audio);
  await pending;
  publish();

  assert.equal(viewers.get("person"), null);
  assert.deepEqual(published.at(-1).zones, []);
  assert.deepEqual(runsOf(priority.mapForOutput(base.outputKey)), []);
  assert.deepEqual(runsOf(priority.mapForOutput(audio.outputKey)), []);
});

test("late rendition choices do not recreate a departed viewer", () => {
  for (const update of [
    (viewers, output) => chooseAudioTrack(viewers, output, "person", { trackIndex: 1, transcode: true }),
    (viewers, output) => noteStepOnScreen(viewers, output, "person", "step"),
    (viewers, output) => noteStepBeingWarmed(viewers, output, "person", "step"),
    (viewers, output) => noteAudioBeingWarmed(viewers, output, "person", "audio"),
    (viewers, output) => watches(viewers, output, "person"),
    (viewers, output) => placeOn(viewers, output, "person", 100)
  ]) {
    const { base, viewers, published, publish } = viewing();
    viewers.hasGone("person");
    update(viewers, base);
    publish();
    assert.equal(viewers.get("person"), null);
    assert.deepEqual(published.at(-1).zones, []);
  }
});

test("a present viewer can join audio, and another viewer keeps the file wanted", () => {
  const { base, audio, viewers, published, publish } = viewing();
  const requests = new ViewerRequests({ viewers, planEncodersSoon() {} });
  viewers.of(base, "other").moveTo(200);
  requests.placeViewerOn(audio, "person", 100);
  assert.equal(viewers.forOutput(audio).has("person"), true);
  viewers.hasGone("person");
  publish();
  assert.ok(published.at(-1).zones.length > 0);
  assert.equal(viewers.forOutput(base).has("other"), true);
  viewers.hasGone("other");
  publish();
  assert.deepEqual(published.at(-1).zones, []);
});

test("departure removes presence before asynchronous output disposal finishes", async () => {
  const { base, viewers } = viewing();
  const lifecycle = new OutputLifecycle({ viewers });
  let complete;
  lifecycle.releaseSessionConsumer = () => new Promise(resolve => { complete = resolve; });
  const leaving = lifecycle.viewerHasGone("person");
  assert.equal(viewers.get("person"), null);
  assert.equal(recordViewerReport({ outputs: new Map([[base.id, base]]), viewers,
    sessionId: base.id, report: { consumerId: "person", playing: true } }), false);
  complete(true);
  assert.equal(await leaving, 1);
});

for (const initiallyKnown of [true, false]) {
  test(`an explicit opening cannot outlive its viewer (known=${initiallyKnown})`, async () => {
    const { base, viewers } = viewing();
    if (!initiallyKnown) viewers.hasGone("person");
    let complete;
    const pending = new Promise(resolve => { complete = resolve; });
    const requests = new ViewerRequests({ viewers, planEncodersSoon() {},
      admitsWatching: () => ({ admitted: true }),
      opening: { open: ({ claim }) => { claim(base); return pending; } }
    });
    const opening = requests.createOrGetSession({ consumerId: "person" });
    viewers.hasGone("person");
    // A genuine reconnect creates a different viewing under the same name;
    // the old opening must not attach itself to that new presence either.
    const returned = viewers.present("person");
    complete({ output: base, existed: false, audio: {} });
    await assert.rejects(opening, { name: "AbortError" });
    assert.equal(viewers.get("person"), returned);
    assert.equal(returned.outputs.size, 0);
  });
}
