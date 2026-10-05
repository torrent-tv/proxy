import test from "node:test";
import assert from "node:assert/strict";
import { Viewers } from "../../services/viewer/Viewers.js";
import { SourcePreparation } from "../../services/viewer/SourcePreparation.js";
import { pauseCoefficient } from "../../services/viewer/PriorityMap.js";

test("retired source preparation is withdrawn and a late result cannot restore it", async () => {
  const viewers = new Viewers();
  const viewer = viewers.selectsFile("person", "source", 0);
  const reads = [], withdrawn = [];
  const preparation = new SourcePreparation({ viewers, candidatesFor: async () => [0],
    inspect: async work => { reads.push(work); return { kind: "result" }; },
    withdraw: work => withdrawn.push(work) });
  await preparation.refresh();
  const original = reads.find(work => work.selected);
  original.urgentReady = true;
  assert.equal(preparation.urgentReadyFor(viewer), true);
  preparation.forget("source");
  assert.equal(preparation.accepts(original), false);
  assert.equal(preparation.ownsFile("source", 0), false);
  assert.equal(preparation.urgentReadyFor(viewer), false);
  assert.ok(withdrawn.includes(original));
  preparation.result(original, { kind: "result" });
  await preparation.refresh();
  const current = reads.findLast(work => work.selected);
  assert.notEqual(current, original);
  assert.equal(preparation.accepts(current), true);
});

test("chosen embedded subtitle input follows an output viewer and is withdrawn on seek or off", async () => {
  const viewers = new Viewers();
  const viewer = viewers.selectsFile("viewer", "source", 0);
  viewers.of({ id: "output" }, "viewer");
  viewers.selectsSubtitle("viewer", "source", 0, 2);
  const reads = [], withdrawn = [];
  const preparation = new SourcePreparation({ viewers, candidatesFor: async () => [0],
    inspect: async work => { reads.push(work); return { kind: "result" }; }, withdraw: work => withdrawn.push(work) });
  await preparation.refresh();
  const original = reads.find(work => work.role === "subtitle-embedded" && work.statement === "packets");
  assert.ok(original);
  assert.equal(original.trackIndex, 2);
  assert.equal(preparation.demandFor(original).priority, 100);
  assert.equal(preparation.subtitleReadyFor(viewer), true);
  viewer.moveTo(20);
  assert.equal(preparation.subtitleReadyFor(viewer), false);
  await preparation.refresh();
  assert.ok(withdrawn.includes(original));
  const current = reads.findLast(work => work.role === "subtitle-embedded" && work.statement === "packets");
  assert.notEqual(current, original);
  assert.match(current.positions, /20/);
  assert.equal(preparation.subtitleReadyFor(viewer), true);
  viewers.clearsSubtitle("viewer", "source");
  await preparation.refresh();
  assert.equal(preparation.demandFor(current), null);
  assert.ok(withdrawn.includes(current));
});

test("a paused direct viewer keeps urgency until exact input is held, then yields to the other viewer", async () => {
  const viewers = new Viewers();
  const paused = viewers.selectsFile("paused", "source", 0, 1000, { wantsToPlay: false });
  viewers.selectsFile("watching", "source", 0, 1000, { wantsToPlay: true });
  let held = false;
  const reads = [], repriced = [];
  const preparation = new SourcePreparation({ viewers, candidatesFor: async () => [0],
    inputReady: async work => held && work.inputRanges[0][0] === 17 && work.inputRanges[0][1] === 81,
    priorityFor: (viewer, priority) => {
      const coefficient = pauseCoefficient({ playing: viewer.playing || viewer.waiting,
        viewerCount: viewers.forSource("source").length, pauseSeconds: 20, allowanceSeconds: 4,
        urgentReady: preparation.urgentReadyFor(viewer) });
      return 1 + Math.floor((priority - 1) * coefficient);
    }, inspect: async work => {
      reads.push(work);
      if (work.selected) work.inputRanges = [[17, 81]];
      return { kind: "result" };
    }, withdraw: () => {}, reprice: (work, demand) => repriced.push([work, demand]) });
  await preparation.refresh();
  const pausedWork = reads.find(work => work.ownerId === "paused");
  const watchingWork = reads.find(work => work.ownerId === "watching");
  assert.equal(preparation.demandFor(pausedWork).priority, 100);
  assert.equal(preparation.demandFor(pausedWork).urgent, true);
  held = true;
  await preparation.bytesChanged("source", 0);
  assert.equal(preparation.demandFor(pausedWork).priority, 17);
  assert.equal(preparation.demandFor(pausedWork).urgent, false);
  assert.equal(preparation.demandFor(watchingWork).priority, 100);
  assert.ok(repriced.some(([work, demand]) => work === pausedWork && demand.priority === 17));
  held = false;
  await preparation.bytesChanged("source", 0);
  assert.equal(preparation.demandFor(pausedWork).urgent, true);
  held = true;
  await preparation.bytesChanged("source", 0);
  viewers.hasGone("watching");
  await preparation.refresh();
  assert.equal(preparation.demandFor(pausedWork).priority, 100);
  assert.equal(paused.outputs.size, 0);
});

test("two direct viewers prepare their own positions and one seek preserves the other's input", async () => {
  const viewers = new Viewers();
  viewers.selectsFile("first", "source", 0, 100, { positionSeconds: 10 });
  viewers.selectsFile("second", "source", 0, 100, { positionSeconds: 300 });
  const reads = [], withdrawn = [];
  const preparation = new SourcePreparation({ viewers, candidatesFor: async () => [0],
    inspect: async work => { reads.push(work); return { kind: "result" }; },
    withdraw: work => withdrawn.push(work) });
  await preparation.refresh();
  const first = reads.find(work => work.selected && work.ownerId === "first");
  const second = reads.find(work => work.selected && work.ownerId === "second");
  assert.deepEqual(JSON.parse(first.positions), [["first", 10]]);
  assert.deepEqual(JSON.parse(second.positions), [["second", 300]]);
  viewers.reportSource("first", "source", 0, { positionSeconds: 80, seek: true,
    generation: 1, playing: false, waiting: true }, 200);
  await preparation.refresh();
  assert.ok(withdrawn.includes(first));
  assert.equal(withdrawn.includes(second), false);
  assert.equal(preparation.accepts(second), true);
  assert.deepEqual(JSON.parse(reads.findLast(work => work.ownerId === "first").positions), [["first", 80]]);
});

test("source-only viewers retain the full source at the lowest priority until an output takes over", async () => {
  const viewers = new Viewers();
  const viewer = viewers.selectsFile("person", "source", 0);
  const reads = [], withdrawn = [];
  const preparation = new SourcePreparation({ viewers, candidatesFor: async () => [0],
    relatedFilesFor: () => [{ fileIndex: 0, role: "source-rest" }],
    inspect: async work => { reads.push(work); return { kind: "result" }; },
    withdraw: work => withdrawn.push(work) });
  await preparation.refresh();
  const work = reads.find(work => work.role === "source-rest" && work.statement === "packets");
  assert.equal(preparation.demandFor(work).priority, 1);
  assert.equal(preparation.demandFor(work).urgent, false);
  assert.ok(reads.indexOf(work) > reads.findIndex(work => work.statement === "packets" && work.selected));
  viewer.outputs.add("picture");
  await preparation.refresh();
  assert.equal(preparation.demandFor(work), null);
  assert.ok(withdrawn.includes(work));
});

test("a seek before an output exists withdraws old input and prepares the new position", async () => {
  const viewers = new Viewers();
  viewers.selectsFile("person", "source", 0, 1000, { positionSeconds: 8 });
  const reads = [], withdrawn = [];
  const preparation = new SourcePreparation({ viewers, candidatesFor: async () => [0],
    inspect: async work => { reads.push(work); return { kind: "result" }; },
    withdraw: work => withdrawn.push(work) });
  await preparation.refresh();
  const old = reads.find(work => work.statement === "packets" && work.selected);
  viewers.selectsFile("person", "source", 0, 2000, { positionSeconds: 40 });
  await preparation.refresh();
  const current = reads.findLast(work => work.statement === "packets" && work.selected);
  assert.notEqual(current, old);
  assert.ok(withdrawn.includes(old));
  assert.equal(preparation.accepts(old), false);
  assert.equal(preparation.accepts(current), true);
  assert.equal(preparation.ownsFile("source", 0), true);
  viewers.hasGone("person");
  await preparation.refresh();
  assert.equal(preparation.ownsFile("source", 0), false);
});

test("all candidate declarations precede visible-file indexes in reading order", async () => {
  const viewers = new Viewers();
  viewers.visibleFiles("person", "source", [2]);
  const reads = [];
  const preparation = new SourcePreparation({ viewers, candidatesFor: async () => [8, 2],
    inspect: async work => { reads.push([work.fileIndex, work.statement, preparation.demandFor(work)]); return { kind: "result" }; },
    withdraw: () => {} });
  await preparation.refresh();
  assert.deepEqual(reads.map(([index, statement]) => [index, statement]),
    [[8, "tracks"], [8, "media-info"], [2, "tracks"], [2, "media-info"], [2, "packets"]]);
  assert.ok(reads.every(([, , demand]) => demand.deadlineAt === Infinity && demand.urgent === false));
});

test("selection withdraws other files and reprices existing declarations before indexed preparation", async () => {
  const viewers = new Viewers();
  viewers.visibleFiles("person", "source", [1, 2]);
  const reads = [], withdrawn = [], repriced = [];
  const preparation = new SourcePreparation({ viewers, candidatesFor: async () => [1, 2],
    inspect: async work => { reads.push(work); return { kind: work.fileIndex === 1 && work.statement === "tracks" ? "needs-ranges" : "result" }; },
    withdraw: work => withdrawn.push(work), reprice: (work, demand) => repriced.push([work, demand]) });
  await preparation.refresh();
  assert.equal(reads.some(work => work.statement === "packets"), false);
  viewers.selectsFile("person", "source", 2);
  await preparation.refresh();
  assert.ok(withdrawn.some(work => work.fileIndex === 1));
  const old = reads.find(work => work.fileIndex === 1 && work.statement === "tracks");
  assert.equal(preparation.accepts(old), false);
  preparation.result(old, { kind: "result" });
  assert.ok(repriced.some(([work, demand]) => work.fileIndex === 2 && demand.deadlineAt === 0 && demand.urgent));
  assert.ok(reads.some(work => work.fileIndex === 2 && work.statement === "packets" && work.selected));
  const count = reads.length;
  viewers.hasGone("person");
  await preparation.refresh();
  assert.equal(reads.length, count);
  assert.equal(preparation.demandFor(reads.at(-1)), null);
});

test("a newer source is prepared without waiting for obsolete torrent metadata", async () => {
  const viewers = new Viewers();
  viewers.selectsSource("person", "old");
  let started;
  const entering = new Promise(resolve => { started = resolve; });
  const reads = [];
  const preparation = new SourcePreparation({ viewers,
    candidatesFor: source => source === "old" ? (started(), new Promise(() => {})) : Promise.resolve([0]),
    inspect: async work => { reads.push(work.sourceKey); return { kind: "result" }; }, withdraw: () => {} });
  const first = preparation.refresh();
  await entering;
  viewers.selectsSource("person", "new");
  await preparation.refresh();
  await first;
  assert.deepEqual(reads, ["new", "new"]);
});

test("selected input precedes related audio and the next episode, which are withdrawn on selection change", async () => {
  const viewers = new Viewers();
  viewers.selectsFile("person", "source", 0);
  const reads = [], withdrawn = [];
  const preparation = new SourcePreparation({ viewers, candidatesFor: async () => [0, 3],
    relatedFilesFor: (_source, index) => index === 0 ? [{ fileIndex: 1, role: "audio" }, { fileIndex: 2, role: "subtitle" }, { fileIndex: 3, role: "next-episode" }] : [],
    inspect: async work => { reads.push([work, preparation.demandFor(work)]); return { kind: "result" }; },
    withdraw: work => withdrawn.push(work) });
  await preparation.refresh();
  const selected = reads.findIndex(([work]) => work.fileIndex === 0 && work.statement === "packets");
  const spare = reads.findIndex(([work]) => work.role === "audio");
  assert.ok(selected >= 0 && spare > selected);
  assert.ok(reads.filter(([work]) => work.ownerFileIndex !== undefined).every(([, demand]) => !demand.urgent && demand.deadlineAt === Infinity && demand.priority < 100));
  assert.ok(reads.some(([work]) => work.role === "next-episode" && work.statement === "packets"));
  assert.equal(reads.some(([work]) => work.role === "subtitle" && work.statement === "packets"), false);
  assert.deepEqual(reads.filter(([work]) => work.role === "subtitle").map(([work]) => work.statement), ["subtitle-file"]);
  viewers.selectsFile("person", "source", 3);
  await preparation.refresh();
  assert.ok(withdrawn.some(work => work.role === "audio"));
  assert.ok(withdrawn.some(work => work.role === "next-episode"));
});
