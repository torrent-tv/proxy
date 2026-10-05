import assert from "node:assert/strict";
import test from "node:test";
import { ProbeRequests } from "../../services/media/ProbeRequests.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

test("allocation refusal waits for memory rather than source bytes", async () => {
  const probes = new ProbeRequests({ publish: async () => {} });
  let attempts = 0;
  const params = { sourceKey: "source", fileIndex: 0, statement: "packets", probe: async () => {
    if (++attempts === 1) throw new IndexMemoryUnavailable(65536);
    return [];
  } };
  assert.equal((await probes.read(params)).kind, "needs-memory");
  probes.bytesChanged("source", 0);
  assert.equal((await probes.read(params)).kind, "needs-memory");
  assert.equal(attempts, 1);
  probes.memoryChanged();
  assert.equal((await probes.read(params)).kind, "result");
  assert.equal(attempts, 2);
});

test("memory arriving during a refused probe is not lost", async () => {
  const probes = new ProbeRequests({ publish: async () => {} });
  let attempts = 0;
  const params = { sourceKey: "source", fileIndex: 0, statement: "packets", probe: async () => {
    if (++attempts === 1) {
      probes.memoryChanged();
      throw new IndexMemoryUnavailable(65536);
    }
    return [];
  } };
  assert.equal((await probes.read(params)).kind, "needs-memory");
  assert.equal((await probes.read(params)).kind, "result");
  assert.equal(attempts, 2);
});

test("a process rejecting after a missing read still publishes that read's demand", async () => {
  const publications = [];
  const probes = new ProbeRequests({ publish: async result => publications.push(result) });
  let attempts = 0;
  const params = { sourceKey: "source", fileIndex: 0, statement: "packets", probe: async ({ requestId }) => {
    if (++attempts === 1) {
      probes.needs(requestId, 100, 199);
      throw new DOMException("Probe aborted", "AbortError");
    }
    return { packets: [] };
  } };
  assert.deepEqual((await probes.read(params)).ranges, [[100, 199]]);
  assert.equal(publications[0].result.kind, "needs-ranges");
  probes.bytesChanged("source", 0);
  assert.equal((await probes.read(params)).kind, "result");
});

test("a probe exception without missing bytes is a remembered terminal result", async () => {
  const probes = new ProbeRequests({ publish: async () => {} });
  let attempts = 0;
  const params = { sourceKey: "source", fileIndex: 0, statement: "packets", probe: async () => {
    attempts++;
    throw new Error("Invalid packet table");
  } };
  assert.equal((await probes.read(params)).reason, "media-probe-failed");
  probes.bytesChanged("source", 0);
  assert.equal((await probes.read(params)).message, "Invalid packet table");
  assert.equal(attempts, 1);
});

test("a missing read cancels the probe, publishes download-only demand and retries on new bytes", async () => {
  const publications = [];
  const probes = new ProbeRequests({ publish: async result => publications.push(result) });
  let attempts = 0;
  const params = { sourceKey: "source", fileIndex: 2, statement: "codec-probe", probe: async ({ requestId, signal }) => {
    attempts++;
    if (attempts === 1) {
      assert.equal(probes.needs(requestId, 10, 19), true);
      assert.equal(signal.aborted, true);
      return { kind: "terminal", reason: "aborted" };
    }
    return { videoCodec: "h264" };
  } };
  const missing = await probes.read(params);
  assert.equal(missing.kind, "needs-ranges");
  assert.deepEqual(missing.ranges, [[10, 19]]);
  assert.equal((await probes.read(params)), missing);
  assert.equal(attempts, 1);
  probes.bytesChanged("source", 1);
  assert.equal(attempts, 1);
  probes.bytesChanged("source", 2);
  assert.equal((await probes.read(params)).value.videoCodec, "h264");
  assert.equal(attempts, 2);
  assert.deepEqual(publications.map(publication => publication.result.kind), ["needs-ranges", "result"]);
  assert.equal(probes.needs(missing.requestId, 20, 29), false);
});

test("bytes arriving while a probe reports missing input are not lost", async () => {
  const probes = new ProbeRequests({ publish: async () => {} });
  let attempts = 0;
  const params = { sourceKey: "source", fileIndex: 0, statement: "codec-probe", probe: async ({ requestId }) => {
    if (++attempts === 1) {
      probes.needs(requestId, 0, 15);
      probes.bytesChanged("source", 0);
    }
    return { audioCodec: "aac" };
  } };
  assert.equal((await probes.read(params)).kind, "needs-ranges");
  assert.equal((await probes.read(params)).kind, "result");
  assert.equal(attempts, 2);
});

test("terminal probe refusals are remembered independently of later storage events", async () => {
  const probes = new ProbeRequests({ publish: async () => {} });
  let attempts = 0;
  const params = { sourceKey: "source", fileIndex: 0, statement: "codec-probe", probe: async () => {
    attempts++;
    return { kind: "terminal", reason: "unsupported-format" };
  } };
  assert.equal((await probes.read(params)).kind, "terminal");
  probes.bytesChanged("source", 0);
  assert.equal((await probes.read(params)).reason, "unsupported-format");
  assert.equal(attempts, 1);
});

test("withdrawal cancels a running probe and its late result cannot restore demand", async () => {
  const publications = [];
  const probes = new ProbeRequests({ publish: async result => publications.push(result) });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = probes.read({ sourceKey: "source", fileIndex: 0, statement: "codec-probe", probe: async ({ signal }) => {
    entered();
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    return { videoCodec: "h264" };
  } });
  await started;
  probes.forget("source", 0);
  assert.equal((await pending).kind, "cancelled");
  assert.deepEqual(publications, []);
  probes.bytesChanged("source", 0);
  await Promise.resolve();
  assert.deepEqual(publications, []);
});

test("forgetting a source releases completed readings for every file", async () => {
  const probes = new ProbeRequests({ publish: async () => {} });
  let attempts = 0;
  const params = fileIndex => ({ sourceKey: "source", fileIndex, statement: "codec-probe",
    probe: async () => ({ value: ++attempts }) });
  await probes.read(params(0));
  await probes.read(params(1));
  probes.forget("source");
  await probes.read(params(0));
  await probes.read(params(1));
  assert.equal(attempts, 4);
});
