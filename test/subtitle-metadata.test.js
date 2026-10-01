import test from "node:test";
import assert from "node:assert/strict";
import { SubtitleFileContainer } from "../services/media/container/SubtitleFileContainer.js";

const ass = `[Script Info]\nTitle: Princess Mononoke\nYear: 1997\nMovie Title: Princess Mononoke\nScript Updated By: 2026\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello`;
test("ASS header evidence survives conversion without changing cues", () => {
  const vtt = SubtitleFileContainer.toVtt(ass, ".ass");
  const json = vtt.match(/NOTE TORRENT-TV-METADATA\n([^\n]+)/u)[1];
  assert.deepEqual(JSON.parse(json), { titles: ["Princess Mononoke"], genericTitles: ["Princess Mononoke"], years: [1997] });
  assert.match(vtt, /00:00:01.000 --> 00:00:02.000\nHello/u);
});
test("metadata is bounded and dialogue is not scanned", () => {
  const vtt = SubtitleFileContainer.toVtt(ass.replace("[Script Info]", "[Other]").replace("Hello", "Movie Title: Another film"), ".ass");
  assert.equal(vtt.includes("NOTE TORRENT-TV-METADATA"), false);
});
