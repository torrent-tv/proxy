/**
 * @file Two axes, kept apart: the framing a CONTAINER puts round a cue, and the
 * markup the CODEC puts inside it.
 *
 * Field 2026-09-03, an English track of an embedded `.mkv`: the viewer was
 * shown `21,0,Default,,0000,0000,0000,,I am the powerful Demon King of the
 * Sixth Heaven.` — the whole dialogue row, fields and all. The cause was one
 * function doing both jobs and deciding which framing it held by counting
 * commas: it expected the ten fields a row has in a FILE, a Matroska block
 * carries nine, so it returned the row untouched.
 *
 * What each check here pins is therefore not "ASS is stripped" but "the right
 * side answers": the container takes off what it put on, and the codec takes
 * off what it put in. The case that matters most is the last one — the same
 * line of dialogue, stored two ways, coming out identical.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { AviContainer } from "../services/container/AviContainer.js";
import { MatroskaContainer } from "../services/container/MatroskaContainer.js";
import { Mp4Container } from "../services/container/Mp4Container.js";
import { SubtitleFileContainer } from "../services/container/SubtitleFileContainer.js";
import { convertSubtitleToVtt, cuesToVtt, finalizeCues } from "../services/subtitle-convert.js";
import { MarkupKind, markupKindOf, plainCueText } from "../services/tracks/subtitle-markup.js";
import { TextSubtitleTrack } from "../services/tracks/TextSubtitleTrack.js";

/** The line from the field report, as Matroska stores it. */
const FIELD_BLOCK =
  "21,0,Default,,0000,0000,0000,,I am the powerful Demon King of the Sixth Heaven. Good... Evil...";

function block(text) {
  return Buffer.from(text, "utf8");
}

test("a Matroska ASS block gives up its text and nothing else", () => {
  // Nine fields exactly, and no comma in the dialogue: the shape that defeated
  // the old field count and put the whole row on the viewer's screen.
  assert.equal(
    MatroskaContainer.cueTextOf(block(FIELD_BLOCK), "S_TEXT/ASS"),
    "I am the powerful Demon King of the Sixth Heaven. Good... Evil..."
  );
});

test("commas in the dialogue are dialogue, not fields", () => {
  assert.equal(
    MatroskaContainer.cueTextOf(block("7,0,Main,Nobunaga,0000,0000,0000,,Yes, of course, my lord"), "S_TEXT/ASS"),
    "Yes, of course, my lord"
  );
});

test("an SSA block is framed the same way as an ASS one", () => {
  // SSA writes `Marked` where ASS writes `Layer`; the count is the same and so
  // is the answer.
  assert.equal(
    MatroskaContainer.cueTextOf(block("3,,Default,,0000,0000,0000,,Toujours rien."), "S_TEXT/SSA"),
    "Toujours rien."
  );
});

test("a row too short to hold a text field yields nothing to show", () => {
  assert.equal(MatroskaContainer.cueTextOf(block("21,0,Default,,0000"), "S_TEXT/ASS"), "");
  assert.equal(MatroskaContainer.cueTextOf(block("21,0,Default,,0000,0000,0000,,"), "S_TEXT/ASS"), "");
});

test("a plain-text Matroska block is not touched at all", () => {
  // `S_TEXT/UTF8` has no framing: the block IS the text, commas included.
  const line = "Yes, of course, my lord";
  assert.equal(MatroskaContainer.cueTextOf(block(line), "S_TEXT/UTF8"), line);
  assert.equal(MatroskaContainer.cueTextOf(block(line), "S_TEXT/WEBVTT"), line);
});

test("an MP4 sample is unframed by the MP4, length prefix and all", () => {
  const text = Buffer.from("Yes, of course, my lord", "utf8");
  const sample = Buffer.concat([Buffer.from([0x00, text.length]), text]);
  assert.equal(Mp4Container.cueTextOf(sample, "tx3g"), "Yes, of course, my lord");
});

test("a container with no framing of its own refuses to guess", () => {
  // AVI declares no subtitle tracks, so no cue can reach it. If one ever did,
  // the answer must be an error and not a guess at somebody else's framing.
  assert.throws(() => AviContainer.cueTextOf(block("x"), "S_TEXT/ASS"), /cueTextOf not implemented/);
});

test("ASS markup is taken off wherever the text came from", () => {
  assert.equal(plainCueText("{\\pos(640,620)}Hello{\\i1} there{\\i0}", "S_TEXT/ASS"), "Hello there");
  assert.equal(plainCueText("First\\NSecond\\nThird", "S_TEXT/ASS"), "First\nSecond\nThird");
  assert.equal(plainCueText("Wide\\hspace", "S_TEXT/ASS"), "Wide space");
  // The same text under a codec that has no such markup keeps its characters.
  assert.equal(plainCueText("{\\pos(1,2)}Hello", "S_TEXT/UTF8"), "{\\pos(1,2)}Hello");
});

test("a codec is known by any of its names", () => {
  assert.equal(markupKindOf("S_TEXT/ASS"), MarkupKind.ASS);
  assert.equal(markupKindOf(".ASS"), MarkupKind.ASS);
  assert.equal(markupKindOf("S_TEXT/UTF8"), MarkupKind.NONE);
  assert.equal(markupKindOf("wvtt"), MarkupKind.NONE);
  // Unknown: shown as it is, rather than refused.
  assert.equal(markupKindOf("S_TEXT/SOMETHING"), MarkupKind.NONE);
});

test("a text track answers for its own markup", () => {
  const track = new TextSubtitleTrack({ trackNumber: 3, declaredIndex: 0, codecId: "S_TEXT/ASS" });
  assert.equal(track.markupKind, MarkupKind.ASS);
  assert.equal(track.plainText("{\\be1}Готовьте лучников"), "Готовьте лучников");
});

test("a file states its own column order and is obeyed", () => {
  // This `Format:` has no `Name` column, so the text is the ninth field and not
  // the tenth. A reader that assumed a position would take the effect field as
  // the line — which is the file-side form of the defect this suite is about.
  const file = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "[Events]",
    "Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:03.50,Default,0000,0000,0000,,Ты видишь их?",
    ""
  ].join("\n");

  const cues = new SubtitleFileContainer({ extension: ".ass" }).readCues(file);
  assert.deepEqual(cues, [{ startSeconds: 1, endSeconds: 3.5, text: "Ты видишь их?" }]);
});

test("a dialogue row before any Format line is not guessed at", () => {
  const file = ["[Events]", "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Ignored", ""].join("\n");
  assert.deepEqual(new SubtitleFileContainer({ extension: ".ass" }).readCues(file), []);
});

test("SubRip cues keep their words and lose their numbering", () => {
  const file = [
    "1",
    "00:00:01,000 --> 00:00:03,500",
    "Ты видишь их?",
    "",
    "2",
    "00:01:02,250 --> 00:01:04,000",
    "<i>Да.</i>",
    "Но не столько вижу.",
    ""
  ].join("\n");

  const cues = new SubtitleFileContainer({ extension: ".srt" }).readCues(file);
  assert.deepEqual(cues, [
    { startSeconds: 1, endSeconds: 3.5, text: "Ты видишь их?" },
    { startSeconds: 62.25, endSeconds: 64, text: "<i>Да.</i>\nНо не столько вижу." }
  ]);
});

test("a SubRip file with no blank line between cues does not swallow the ordinal", () => {
  const file = [
    "1",
    "00:00:01,000 --> 00:00:02,000",
    "First",
    "2",
    "00:00:03,000 --> 00:00:04,000",
    "Second"
  ].join("\n");

  const cues = new SubtitleFileContainer({ extension: ".srt" }).readCues(file);
  assert.deepEqual(cues.map((cue) => cue.text), ["First", "Second"]);
});

test("a WebVTT file is passed through, not taken apart", () => {
  const file = "WEBVTT\n\nSTYLE\n::cue { color: yellow }\n\nintro\n00:00:01.000 --> 00:00:02.000\nHello\n";
  assert.equal(convertSubtitleToVtt(file, ".vtt"), file);
  assert.equal(new SubtitleFileContainer({ extension: ".vtt" }).readCues(file), null);
});

test("a format nothing here reads is refused rather than mangled", () => {
  assert.equal(convertSubtitleToVtt("whatever", ".sup"), null);
  assert.equal(convertSubtitleToVtt("whatever", ".ttml"), null);
});

test("one line of dialogue, two framings, one result", () => {
  // The whole point of the split. The same ASS line stored in a Matroska block
  // and in a file must reach the viewer identically, and neither path may know
  // anything about the other.
  const spoken = "Yes, of course, my lord";
  const markup = `{\\pos(640,620)}${spoken}`;

  const fromBlock = finalizeCues(
    [{
      startSeconds: 1,
      endSeconds: 3,
      text: MatroskaContainer.cueTextOf(block(`21,0,Default,,0000,0000,0000,,${markup}`), "S_TEXT/ASS")
    }],
    "S_TEXT/ASS"
  );

  const fromFile = new SubtitleFileContainer({ extension: ".ass" }).readCues([
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0000,0000,0000,,${markup}`,
    ""
  ].join("\n"));

  assert.equal(fromBlock[0].text, spoken);
  assert.equal(finalizeCues(fromFile, ".ass")[0].text, spoken);
  assert.equal(cuesToVtt(fromBlock, "S_TEXT/ASS"), cuesToVtt(fromFile, ".ass"));
});
