import test from "node:test";
import assert from "node:assert/strict";
import { mapForViewer, mergeMaps } from "../../services/viewer/PriorityMap.js";

// Arithmetic only; no torrent.
//
// The map is held as the rules that say what each viewer wants and answered
// for a second, a stretch, or as stretches (torrent-tv/meta#178). The rules are
// unchanged; here they are written out second by second, the way the map was
// held until then, and every answer of the map is checked against them.

const STEP_TOP = 100;

/** The rules, one array entry per second: the reference. */
function reference(viewers) {
  const length = Math.max(0, ...viewers.map(viewer => Math.ceil(viewer.durationSeconds)));
  const merged = { priority: new Array(length).fill(0), until: new Array(length).fill(Infinity),
    behind: new Array(length).fill(true), urgent: new Array(length).fill(false), anyFront: new Array(length).fill(false),
    unyielded: new Array(length).fill(false) };
  for (const viewer of viewers) {
    const duration = Math.ceil(viewer.durationSeconds);
    const at = viewer.atSeconds > 0 ? Math.floor(viewer.atSeconds) : 0;
    const allowance = viewer.allowanceSeconds > 0 ? viewer.allowanceSeconds : duration;
    const attenuate = viewer.playing === false && viewer.urgentReady && viewer.viewerCount > 1;
    const coefficient = attenuate ? allowance / (allowance + viewer.pauseSeconds) : 1;
    for (let second = 0; second < duration; second++) {
      if (second < at) {
        merged.priority[second] = Math.max(merged.priority[second], 1);
        continue;
      }
      const distance = second - at;
      const step = distance > 0 ? Math.floor(Math.log2(1 + distance / allowance)) : 0;
      const priority = Math.max(1, 1 + Math.floor((Math.max(1, STEP_TOP - step) - 1) * coefficient));
      merged.priority[second] = Math.max(merged.priority[second], priority);
      merged.until[second] = Math.min(merged.until[second], distance + (attenuate ? viewer.pauseSeconds : 0));
      merged.behind[second] = false;
      if (distance < allowance && !attenuate) merged.urgent[second] = true;
      if (!attenuate) merged.unyielded[second] = true;
    }
  }
  return {
    length,
    at: second => ({ priority: merged.priority[second], untilSeconds: merged.until[second], behind: merged.behind[second],
      urgent: merged.urgent[second], deferred: !merged.behind[second] && !merged.unyielded[second] })
  };
}

function numbers(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function viewersOf(random) {
  const duration = 1 + Math.floor(random() * 2500);
  const count = 1 + Math.floor(random() * 4);
  return Array.from({ length: count }, () => ({
    atSeconds: random() < 0.1 ? duration + 5 : random() * duration,
    durationSeconds: random() < 0.15 ? Math.ceil(random() * duration) : duration,
    allowanceSeconds: random() < 0.1 ? 0 : 0.5 + random() * 40,
    playing: random() < 0.7,
    pauseSeconds: random() * 600,
    urgentReady: random() < 0.5,
    viewerCount: count
  }));
}

test("the map answers every second as the rules written second by second do", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const viewers = viewersOf(numbers(seed));
    const map = mergeMaps(viewers.map(viewer => mapForViewer(viewer)));
    const rules = reference(viewers);
    assert.equal(map.durationSeconds, rules.length, `seed ${seed}`);
    for (let second = 0; second < rules.length; second++) {
      assert.deepEqual(map.at(second), rules.at(second), `seed ${seed}, second ${second}`);
    }
  }
});

test("a stretch is wanted as its strongest, soonest, nearest second", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const random = numbers(seed);
    const viewers = viewersOf(random);
    const map = mergeMaps(viewers.map(viewer => mapForViewer(viewer)));
    const rules = reference(viewers);
    for (let from = 0; from < rules.length;) {
      const to = from + 1 + Math.floor(random() * 9);
      let priority = 0, withinSeconds = Infinity, behind = true, urgent = false;
      for (let second = from; second < Math.min(to, rules.length); second++) {
        const point = rules.at(second);
        priority = Math.max(priority, point.priority);
        withinSeconds = Math.min(withinSeconds, point.untilSeconds);
        if (!point.behind) behind = false;
        if (point.urgent) urgent = true;
      }
      assert.deepEqual(map.on(from, to), { priority, withinSeconds, behind, urgent }, `seed ${seed}, ${from}-${to}`);
      from = to;
    }
  }
});

test("the stretches and the viewers' starts are read off the same seconds", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const viewers = viewersOf(numbers(seed));
    const map = mergeMaps(viewers.map(viewer => mapForViewer(viewer)));
    const rules = reference(viewers);
    const runs = [];
    const starts = [];
    for (let second = 0; second < rules.length; second++) {
      const point = rules.at(second);
      const before = second === 0 ? 1 : rules.at(second - 1).priority;
      if (point.priority > before && point.priority > 1) starts.push(second);
      if (point.priority === 0) continue;
      const previous = runs.at(-1);
      if (previous && previous.to === second && previous.priority === point.priority && previous.behind === point.behind &&
        previous.urgent === point.urgent && previous.deferred === point.deferred) {
        previous.to = second + 1;
        continue;
      }
      runs.push({ from: second, to: second + 1, priority: point.priority, withinSeconds: point.untilSeconds,
        behind: point.behind, urgent: point.urgent, deferred: point.deferred });
    }
    assert.deepEqual(map.runs(), runs, `seed ${seed}`);
    assert.deepEqual(map.viewerStarts(), starts, `seed ${seed}`);
  }
});
