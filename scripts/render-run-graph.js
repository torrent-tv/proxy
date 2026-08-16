#!/usr/bin/env node
/**
 * @file Render the encoder-run table as a document, FROM the table.
 *
 * The picture is not drawn beside the code — it is produced from the same data
 * the code executes, so it cannot describe a machine that no longer exists. A
 * test regenerates it and compares, which is what makes "the table is the
 * single source" enforceable rather than a promise.
 *
 * Run it with `npm run graph`.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ABSENT_EDGE_INVARIANTS,
  ENCODE_RUN_EVENT,
  ENCODE_RUN_STATE,
  EVENT_MEANING,
  INITIAL_RUN_STATE,
  STATE_MEANING,
  answerForMissingSegment,
  declaredContainment,
  declaredEdges,
  isInputBeingRead,
  mayRestart,
  processCanBeSignalled,
  wireState
} from "../services/encode-run-state.js";

/** Where the rendered document lives. */
export const GRAPH_DOC_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "encode-run-state.md"
);

const ALL_STATES = Object.values(ENCODE_RUN_STATE);
const ALL_EVENTS = Object.values(ENCODE_RUN_EVENT);

/**
 * Children of each node of the containment tree, in declaration order.
 *
 * @returns {{ root: string, childrenOf: Map<string, string[]> }}
 */
function containmentTree() {
  const childrenOf = new Map();
  let root = null;
  for (const { state, parent } of declaredContainment()) {
    if (parent === null) {
      root = state;
      continue;
    }
    if (!childrenOf.has(parent)) {
      childrenOf.set(parent, []);
    }
    childrenOf.get(parent).push(state);
  }
  return { root, childrenOf };
}

/**
 * One composite block, and everything nested inside it.
 *
 * @param {string} node
 * @param {Map<string, string[]>} childrenOf
 * @param {number} depth
 * @returns {string[]} Lines, already indented.
 */
function renderBlock(node, childrenOf, depth) {
  const pad = "    ".repeat(depth);
  const children = childrenOf.get(node) ?? [];
  if (children.length === 0) {
    return [`${pad}${node}`];
  }
  const lines = [`${pad}state ${node} {`];
  if (children.includes(INITIAL_RUN_STATE)) {
    lines.push(`${pad}    [*] --> ${INITIAL_RUN_STATE}`);
  }
  for (const child of children) {
    lines.push(...renderBlock(child, childrenOf, depth + 1));
  }
  lines.push(`${pad}}`);
  return lines;
}

/**
 * The whole document.
 *
 * @returns {string}
 */
export function renderRunGraphMarkdown() {
  const { root, childrenOf } = containmentTree();
  const lines = [];

  lines.push(
    "<!-- GENERATED from services/encode-run-state.js by scripts/render-run-graph.js.",
    "     Do not edit by hand: change the table and run `npm run graph`. -->",
    "",
    "# The encoder run — states and transitions",
    "",
    "One run of one ffmpeg inside one transcode session. The table this is drawn",
    "from is executed by `services/hls-session-manager.js`; every transition a real",
    "run makes is logged as state, event and target, so a run that takes an edge",
    "absent here is a violation the log names.",
    "",
    "```mermaid",
    "stateDiagram-v2"
  );
  lines.push(...renderBlock(root, childrenOf, 1));
  lines.push("");
  for (const edge of declaredEdges()) {
    lines.push(`    ${edge.from} --> ${edge.to} : ${edge.event}`);
  }
  lines.push("```", "");

  lines.push("## States", "", "| state | means |", "|---|---|");
  for (const state of ALL_STATES) {
    lines.push(`| \`${state}\` | ${STATE_MEANING[state]} |`);
  }
  lines.push("");

  lines.push("## Events", "", "| event | means |", "|---|---|");
  for (const event of ALL_EVENTS) {
    lines.push(`| \`${event}\` | ${EVENT_MEANING[event]} |`);
  }
  lines.push("");

  lines.push(
    "## What each state answers",
    "",
    "Outputs depend on the state alone — computed here by calling the same",
    "functions the session manager calls.",
    "",
    "| state | reads its input | can be signalled | a missing segment | on the wire | may restart |",
    "|---|---|---|---|---|---|"
  );
  for (const state of ALL_STATES) {
    lines.push(
      `| \`${state}\` | ${isInputBeingRead(state) ? "yes" : "no"} | ` +
        `${processCanBeSignalled(state) ? "yes" : "no"} | ${answerForMissingSegment(state)} | ` +
        `\`${wireState(state)}\` | ${mayRestart(state) ? "yes" : "no"} |`
    );
  }
  lines.push("");

  lines.push(
    "## Edges that must never exist",
    "",
    "The machine's real content: a near-complete digraph asserts nothing.",
    "",
    "| from | event | must not reach | because |",
    "|---|---|---|---|"
  );
  for (const invariant of ABSENT_EDGE_INVARIANTS) {
    lines.push(
      `| \`${invariant.from}\` | \`${invariant.event}\` | \`${invariant.mustNotReach}\` | ${invariant.because} |`
    );
  }
  lines.push("");

  return `${lines.join("\n")}`;
}

// Written only when this file is the program being run, so importing it from a
// test cannot rewrite the very file the test is about to compare against.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(GRAPH_DOC_PATH, renderRunGraphMarkdown(), "utf8");
  process.stdout.write(`wrote ${GRAPH_DOC_PATH}\n`);
}
