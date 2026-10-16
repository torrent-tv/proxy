/**
 * @file Shares of the machine where this process may use fewer cores than the
 * host has (torrent-tv/meta#180, phase 3).
 *
 * No particular machine is described: each case is a class the proxy may run
 * on — a container with a fractional quota on a large host, a CPU set, a host
 * with no bound at all. Without a bound smaller than the host every answer is
 * the one before this change.
 */

import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { availableShareFrom } from "../../services/encode/available-share.js";
import { configurationKeyOf } from "../../services/encode/fingerprint.js";
import { freeShareDuring, shareOfMachine } from "../../services/encode/host-load.js";
import { HostLoad } from "../../services/encode/quality/HostLoad.js";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("under a 1.5-core quota on an 8-core host, a busy neighbour takes only what the host lacks", () => {
  // Other containers on 5.7 cores, the proxy on 0.3, our encoders on 1:
  // 7 of 8 host cores busy. The host leaves the encoders 8 − 6 = 2 cores; the
  // quota leaves them 1.5 − 0.3 = 1.2. Of the 1.5 cores, 0.8.
  const availability = availableShareFrom({
    systemBusy: 7 / 8, encoderShare: 1 / 8, proxyShare: 0.3 / 8, hostCores: 8, boundCores: 1.5
  });
  assert.equal(availability.known, true);
  assert.equal(availability.boundCores, 1.5);
  close(availability.forEncoders, 0.8);
  // What other processes leave the proxy: 8 − 5.7 = 2.3 cores, more than the
  // quota, so the whole quota.
  close(availability.share, 1);
  // Unattributed stays a fraction of the host.
  close(availability.unattributed, 5.7 / 8);
});

test("under a quota, the proxy's own draw is taken from the quota, not from the host", () => {
  // A quiet host, the proxy on half a core of a one-core quota: half is left.
  const availability = availableShareFrom({
    systemBusy: 0.5 / 8, encoderShare: 0, proxyShare: 0.5 / 8, hostCores: 8, boundCores: 1
  });
  close(availability.forEncoders, 0.5);
  close(availability.share, 1);
});

test("under a quota, a host busier than the quota leaves what it leaves", () => {
  // 7.6 of 8 host cores taken by others: 0.4 core left, under a 2-core quota.
  const availability = availableShareFrom({
    systemBusy: 7.6 / 8, encoderShare: 0, proxyShare: 0, hostCores: 8, boundCores: 2
  });
  close(availability.forEncoders, 0.2);
  close(availability.share, 0.2);
});

test("a bound not smaller than the host changes nothing", () => {
  const reading = { systemBusy: 0.99, encoderShare: 0.56, proxyShare: 0.2 };
  const before = availableShareFrom(reading);
  assert.deepEqual(availableShareFrom({ ...reading, hostCores: 4, boundCores: 4 }), before);
  assert.deepEqual(availableShareFrom({ ...reading, hostCores: 4, boundCores: null }), before);
  assert.deepEqual(availableShareFrom({ ...reading, hostCores: null, boundCores: 1 }), before);
});

test("a host that cannot say still says so under a bound", () => {
  assert.deepEqual(availableShareFrom({ systemBusy: null, hostCores: 8, boundCores: 1.5 }),
    { share: 1, forEncoders: 1, unattributed: 0, known: false });
});

test("a startup reading under a quota divides out a share of the quota, not of the host", () => {
  // The measured ffmpeg on 1.4 cores, other containers on 5 cores of 8, the
  // proxy on 0.1 inside the 1.5-core quota. Of the host, 1 − 5.1/8 was left;
  // of the quota, all but the proxy's 0.1.
  const before = { takenAt: 0, processCpuSeconds: 0, system: { busySeconds: 0, iowaitSeconds: 0 }, proxyCpuSeconds: 0 };
  const after = { takenAt: 1000, processCpuSeconds: 1.4, system: { busySeconds: 6.5, iowaitSeconds: 0 }, proxyCpuSeconds: 0.1 };
  close(freeShareDuring(before, after, 8), 1 - 5.1 / 8);
  close(freeShareDuring(before, after, 8, 1.5), 1.4 / 1.5);
  // Without a reading of the proxy's own draw, the quota alone.
  const unread = { ...after, proxyCpuSeconds: null };
  close(freeShareDuring(before, unread, 8, 1.5), 1);
  // A bound equal to the host is no bound.
  close(freeShareDuring(before, after, 8, 8), 1 - 5.1 / 8);
});

test("a software encoder's key names the bound only where one binds", () => {
  const fingerprint = { ffmpeg: "7.1", x264: "core 164", cpu: "Some CPU", threads: 8, devices: {} };
  const software = { name: "libx264", kind: "software" };
  const unbound = configurationKeyOf(fingerprint, software);
  assert.equal(configurationKeyOf({ ...fingerprint, boundCores: null }, software), unbound);
  assert.equal(configurationKeyOf({ ...fingerprint, boundCores: 1.5 }, software), `${unbound};bound=1.5`);
  assert.notEqual(configurationKeyOf({ ...fingerprint, boundCores: 1.5 }, software),
    configurationKeyOf({ ...fingerprint, boundCores: 2 }, software));
  const vaapi = { name: "h264_vaapi", kind: "vaapi" };
  assert.equal(configurationKeyOf({ ...fingerprint, boundCores: 1.5 }, vaapi), configurationKeyOf(fingerprint, vaapi));
});

test("the machine's availability is of the bound the processor reading carries", async t => {
  let now = 0, busy = 0, proxy = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(os, "cpus", () => Array.from({ length: 8 }, () => ({ model: "cpu", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })));
  const load = new HostLoad({
    outputs: new Map(),
    readProxyCpuSeconds: () => proxy,
    readSystemCpu: async () => ({ busySeconds: busy, idleSeconds: 0, iowaitSeconds: 0 }),
    shareOfMachine: (before, after) => shareOfMachine(before, after, 8),
    sampleProcessor: () => ({ takenAt: now, bound: { cores: 1.5, parallelism: 8, quotaCores: 1.5, source: "cgroup v2 cpu.max" },
      cgroup: null, idleSeconds: null })
  });
  await load.reportHostLoad();
  // Nothing encodes: 6 of 8 host cores busy, 0.3 of them the proxy's.
  now += 1000; busy += 6; proxy += 0.3;
  await load.reportHostLoad();
  assert.equal(load.hostAvailability.known, true);
  assert.equal(load.hostAvailability.boundCores, 1.5);
  // The host leaves 2 cores, the quota 1.2: 0.8 of 1.5. Of the host it was 0.25.
  close(load.hostAvailability.forEncoders, 0.8);
  close(load.hostAvailability.share, 1);
  // Other work's cores, for the pause rule; the free cores are not read here.
  close(load.hostAvailability.otherCores, 5.7);
  assert.equal(load.hostAvailability.freeCores, null);
});
