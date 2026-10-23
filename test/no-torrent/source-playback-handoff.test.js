import test from "node:test";
import assert from "node:assert/strict";
import { Viewers } from "../../services/viewer/Viewers.js";
import { DownloadMaps } from "../../services/viewer/DownloadMaps.js";
import { SourcePreparation } from "../../services/viewer/SourcePreparation.js";
import { publishPlaybackBeforePreparationRefresh } from "../../services/server/publish-playback-before-preparation-refresh.js";

test("playback map is applied before selected-file preparation demand is withdrawn", async () => {
  const viewers = new Viewers();
  const viewer = viewers.selectsFile("viewer", "source", 0);
  const mapsSent = [];
  let finishMapApplication;
  const mapApplication = new Promise(resolve => { finishMapApplication = resolve; });
  const maps = new DownloadMaps({
    publish: map => {
      mapsSent.push(map.zones);
      return map.zones.some(zone => zone.from === 0 && zone.to === 10) ? mapApplication : undefined;
    }
  });
  const withdrawn = [];
  const preparation = new SourcePreparation({
    viewers,
    candidatesFor: async () => [0],
    relatedFilesFor: () => [{ fileIndex: 0, role: "source-rest" }],
    playbackAppliedFor: (sourceKey, fileIndex) => maps.hasAppliedPlayback(sourceKey, fileIndex),
    inspect: async work => {
      if (work.statement === "packets" && work.selected) {
        await maps.metadata({ sourceKey: "source", fileIndex: 0, statement: work.requestId,
          scope: "preparation", result: { kind: "needs-ranges", ranges: [[0, 99]], requestId: work.requestId } });
      }
      if (work.statement === "packets" && work.role === "source-rest") {
        await maps.native({ sourceKey: "source", fileIndex: 0,
          zones: [{ byteStart: 1000, byteEnd: 1999, priority: 1 }] });
      }
      return work.statement === "packets" ? { kind: "needs-ranges" } : { kind: "result" };
    },
    withdraw: work => {
      withdrawn.push(work);
      if (work.role === "source-rest" && work.statement === "packets") {
        void maps.native({ sourceKey: work.sourceKey, fileIndex: work.fileIndex, zones: [] });
      }
      void maps.withdrawMetadata(work.sourceKey, work.fileIndex, work.requestId);
    }
  });

  await preparation.refresh();
  assert.equal(preparation.ownsFile("source", 0), true);
  assert.equal(maps.hasAppliedPlayback("source", 0), false);
  const before = mapsSent.length;
  viewer.outputs.add("output");
  await preparation.refresh();
  assert.equal(preparation.ownsFile("source", 0), true, "opening keeps preparation until playback is applied");
  assert.ok(mapsSent.slice(before).every(zones => zones.length > 0), "opening never publishes an empty map");
  let finishPlayback;
  const applied = new Promise(resolve => { finishPlayback = resolve; });
  const handoff = publishPlaybackBeforePreparationRefresh(
    async () => {
      await applied;
      return maps.playback({ sourceKey: "source", fileIndex: 0, durationSeconds: 10,
        zones: [{ from: 0, to: 10, priority: 100 }] });
    },
    () => preparation.refresh()
  );

  await new Promise(resolve => setImmediate(resolve));
  assert.ok(mapsSent.slice(before).every(zones => zones.length > 0), "preparation demand remains while playback mapping is pending");
  assert.deepEqual(withdrawn, []);
  finishPlayback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maps.hasAppliedPlayback("source", 0), false, "unacknowledged playback does not release preparation");
  assert.deepEqual(withdrawn, []);

  finishMapApplication({ appliedMs: 1 });
  await handoff;
  await preparation.refresh();

  assert.equal(maps.hasAppliedPlayback("source", 0), true);
  assert.ok(mapsSent.at(-1).some(zone => zone.from === 0 && zone.to === 10),
    "the playback map remains wanted after preparation is withdrawn");
  assert.ok(withdrawn.length > 0);
});
