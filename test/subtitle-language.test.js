/**
 * @file What the language detector is FED.
 *
 * Field 2026-09-01: a Russian subtitle file was offered to the viewer as
 * `English (Stan WarHammer & Nesitach)`. The detector was not at fault — it was
 * handed the raw `.ass` file, which is half Latin markup, while the markup-free
 * WebVTT it was about to serve sat in the variable beside it. Measured on that
 * file: 5040 Latin characters against 5983 Cyrillic, `franc(the file) = eng`,
 * `franc(the dialogue) = rus`.
 * `research/subtitle-language-ass-markup-2026-09-01.md`.
 *
 * These checks pin the input at each of the three places a language is read.
 *
 * **On the size of the fixtures.** franc's answer among the Cyrillic languages
 * is not stable on a small sample: measured 2026-09-01 by growing one Russian
 * text line by line, it answered `bul` at 129 characters, `srp` at 158, 241 and
 * `bul` again at 292, then `rus` at every length from 337 to 881. So the
 * dialogue here is ~880 Cyrillic characters — past that boundary by a factor of
 * about 2.6, and still an order of magnitude below a real episode's 5983. The
 * fixtures are NOT sized to make these checks pass; they are sized to resemble
 * the thing. That instability is a separate defect and is recorded as one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { cueTextOfVtt, detectLanguage, detectLanguageFromVtt } from "../services/language-detect.js";
import { convertSubtitleToVtt } from "../services/subtitle-convert.js";
import { finalizeCues } from "../services/torrent-worker/subtitle-cues.js";

/** Varied Russian dialogue, the length a few minutes of an episode carries. */
const RUSSIAN_DIALOGUE = [
  "Ты видишь их?",
  "Да.",
  "Но не столько вижу, сколько чувствую.",
  "Скорее всего, они будут здесь с минуты на минуту.",
  "Почему господа октябристы решили напасть именно сейчас?",
  "Им никогда не преодолеть эти стены.",
  "Мы держали эту крепость три года и продержим ещё столько же.",
  "Готовьте лучников на восточной стороне.",
  "Если они подойдут ближе, мы откроем огонь без предупреждения.",
  "Я не собираюсь умирать здесь, в этой богом забытой дыре.",
  "Тогда возьми меч и вставай рядом со мной.",
  "Сколько у нас осталось воды и хлеба?",
  "На неделю, если не считать раненых.",
  "Раненых считать придётся, они тоже люди.",
  "Отправь гонца к южным воротам и передай приказ отступать.",
  "Он не успеет, дорога перерезана ещё вчера вечером.",
  "Значит пойду сам, а ты останешься за меня командовать.",
  "Это безумие, и ты прекрасно об этом знаешь.",
  "Безумие — это сидеть и ждать, пока нас перебьют по одному.",
  "Хорошо. Но возьми с собой хотя бы двоих.",
  "Двоих я возьму. Больше не могу себе позволить.",
  "Береги себя. Мы будем держать стену до последнего.",
  "Я знаю. Именно поэтому я и ухожу спокойно.",
  "Смотри, дым над лесом. Они уже жгут деревни.",
  "Тогда времени у нас меньше, чем мы думали."
];

/** `hh:mm:ss.cc` for the ASS `Start`/`End` fields. */
function assTime(seconds) {
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `0:${mm}:${ss}.00`;
}

/**
 * An ASS file in the shape a fansub release ships: an Aegisub header, a styles
 * section with English font and style names, and Russian dialogue carrying
 * override groups. Modelled on the field file.
 */
const RUSSIAN_ASS = `[Script Info]
Title: Default Aegisub file
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
Original Translation: Nesitach
Original Editing: Stan WarHammer
WrapStyle: 0
ScaledBorderAndShadow: no
Video Aspect Ratio: c1.77778
YCbCr Matrix: TV.601
Aegisub Video Aspect Ratio: c1.777778

[Aegisub Project Garbage]
Last Style Storage: Default
Audio File: [HorribleSubs] Drifters - 03 [720p].mkv
Video File: [HorribleSubs] Drifters - 03 [720p].mkv
Video AR Mode: 4
Video AR Value: 1.777778
Video Zoom Percent: 0.600000
Scroll Position: 256
Active Line: 257
Video Position: 33159

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Trebuchet MS,54,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2.5,1.5,2,20,20,25,1
Style: Signs,Times New Roman,48,&H00FFFF00,&H000000FF,&H00202020,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,8,20,20,20,1
Style: Italics,Trebuchet MS Italic,54,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,-1,0,0,100,100,0,0,1,2.5,1.5,2,20,20,25,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${RUSSIAN_DIALOGUE.map((line, index) => {
    const style = index % 7 === 6 ? "Signs" : "Default";
    const tag = index % 5 === 4 ? "{\\pos(640,620)}" : "";
    return `Dialogue: 0,${assTime(index * 4)},${assTime(index * 4 + 3)},${style},,0,0,0,,${tag}${line}`;
  }).join("\n")}
`;

test("a Russian .ass is reported as Russian, and its markup does not reach the detector", () => {
  const vtt = convertSubtitleToVtt(RUSSIAN_ASS, ".ass");
  assert.ok(vtt.startsWith("WEBVTT"), "the conversion produced a WebVTT document");

  const spoken = cueTextOfVtt(vtt);
  // Every one of these is a piece of the file the viewer never reads, and each
  // was competing with the dialogue for the detector's answer.
  for (const markup of [
    "Aegisub", "Script Info", "V4+ Styles", "Format:", "Dialogue:",
    "Trebuchet MS", "Times New Roman", "Default", "Signs", "pos(",
    "-->", "0:00:12"
  ]) {
    assert.ok(!spoken.includes(markup), `cue text still carries "${markup}"`);
  }
  assert.ok(spoken.includes("Ты видишь их?"), "cue text keeps the dialogue");

  assert.deepEqual(detectLanguageFromVtt(vtt), { code: "ru", name: "Russian" });
});

test("the fixture is the hard case: the file itself is nearly half Latin", () => {
  // Not an assertion about franc — an assertion that this fixture reproduces the
  // field file's proportions. A fixture whose markup were negligible would pass
  // the check above with or without the fix.
  const cyrillic = (RUSSIAN_ASS.match(/[Ѐ-ӿ]/gu) ?? []).length;
  const latin = (RUSSIAN_ASS.match(/[A-Za-z]/g) ?? []).length;
  assert.ok(cyrillic > 800, `too little dialogue: ${cyrillic} Cyrillic characters`);
  assert.ok(latin > cyrillic * 0.5, `markup too small to reproduce the fault: ${latin} vs ${cyrillic}`);
});

test("cue identifiers, NOTE, STYLE and REGION blocks are not text", () => {
  const vtt = [
    "WEBVTT - This file has cues.",
    "Kind: captions",
    "Language: en",
    "",
    "NOTE",
    "Translated by an English speaking volunteer, all rights reserved.",
    "",
    "STYLE",
    "::cue { background-image: linear-gradient(to bottom, dimgray, lightgray); }",
    "",
    "REGION",
    "id:speaker width:40% lines:3 regionanchor:0%,100%",
    "",
    "opening-line",
    "00:00:12.060 --> 00:00:13.270 align:start position:0%",
    "<v Тоёхиса>Ты видишь их?</v>",
    "",
    "2",
    "00:00:15.400 --> 00:00:16.650",
    "<i>Но не столько вижу,</i>",
    "сколько чувствую &amp; ощущаю.",
    ""
  ].join("\n");

  const spoken = cueTextOfVtt(vtt);
  assert.equal(
    spoken,
    "Ты видишь их?\nНо не столько вижу,\nсколько чувствую   ощущаю."
  );
});

test("a document with no cues yields no language rather than a guess", () => {
  assert.equal(cueTextOfVtt("WEBVTT\n"), "");
  assert.equal(detectLanguageFromVtt("WEBVTT\n"), null);
  assert.equal(detectLanguageFromVtt(null), null);
});

test("an embedded ASS cue is read through finalizeCues, not raw", () => {
  // What the cluster walk holds: the dialogue row without its `Dialogue:`
  // header — nine comma-separated fields, then the text with override groups.
  const cues = RUSSIAN_DIALOGUE.map((line, index) => ({
    startSeconds: index * 4,
    endSeconds: index * 4 + 3,
    text: `0,${assTime(index * 4)},${assTime(index * 4 + 3)},Default,,0,0,0,,` +
      `${index % 5 === 4 ? "{\\pos(640,620)}" : ""}${line}`
  }));

  const spoken = finalizeCues(cues, "S_TEXT/ASS").map((cue) => cue.text).join("\n");
  assert.ok(!spoken.includes("Default"), "the style field survived into the text");
  assert.ok(!spoken.includes("pos("), "an override group survived into the text");
  assert.ok(!spoken.includes("0:00:12"), "a timestamp field survived into the text");
  assert.deepEqual(detectLanguage(spoken), { code: "ru", name: "Russian" });
});

test("too little text is answered with nothing, not with a guess", () => {
  // Measured 2026-09-02 (`research/franc-boundary-2026-09-02.md`): franc's
  // answer for Russian walks between Bulgarian, Serbian and Russian until about
  // 650 characters. Below that the honest answer is none — the browser then
  // shows "Unknown", and the label moves when enough of the file has arrived.
  const short = RUSSIAN_DIALOGUE.slice(0, 6).join("\n");
  assert.ok(short.length < 300, `the fixture must be short: ${short.length}`);
  assert.equal(detectLanguage(short), null);

  const long = RUSSIAN_DIALOGUE.join("\n");
  assert.ok(long.length > 650, `the fixture must be long enough: ${long.length}`);
  assert.deepEqual(detectLanguage(long), { code: "ru", name: "Russian" });
});

test("an answer that does not survive losing half the text is not an answer", () => {
  // A file carrying two languages — a bilingual release, or a track that turns
  // into signs-only English partway. franc answers something for the whole; the
  // halves disagree with it, and that disagreement is the text saying the
  // answer rests on where it happened to be cut.
  const english = [
    "Do you see them out there beyond the wall?",
    "I do, though not as clearly as I would like to.",
    "They have been gathering since the morning came.",
    "We should send word to the southern gate at once.",
    "The road was cut yesterday and no rider will pass.",
    "Then we hold what we have and wait for the dawn."
  ].join("\n");
  const mixed = `${RUSSIAN_DIALOGUE.slice(0, 13).join("\n")}\n${english}`;
  assert.equal(detectLanguage(mixed), null);
});

test("a WebVTT body is decoded whole, so no character is cut in half", () => {
  // The ffmpeg extraction path used to detect on `String(body.subarray(0, 4096))`.
  // Two faults: a byte cut lands mid-character on any non-Latin track, and most
  // of those bytes are timestamps rather than words. Cyrillic is two bytes per
  // character in UTF-8, so 4096 bytes of this document is a few hundred
  // characters of dialogue — inside the unstable region measured above.
  const cues = RUSSIAN_DIALOGUE.map((line, index) => {
    const start = `00:00:${String(index * 2).padStart(2, "0")}.000`;
    const end = `00:00:${String(index * 2 + 1).padStart(2, "0")}.000`;
    return `${start} --> ${end}\n${line}`;
  });
  const body = Buffer.from(`WEBVTT\n\n${cues.join("\n\n")}\n`, "utf8");

  assert.deepEqual(detectLanguageFromVtt(body.toString("utf8")), { code: "ru", name: "Russian" });
});
