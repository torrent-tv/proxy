import assert from "node:assert/strict";
import test from "node:test";
import { playbackDeclarations } from "../../services/media/playback-declarations.js";
import { matroskaTrackIdentity } from "../../services/encode/MatroskaInput.js";
import { decodeFamilyOf } from "../../services/encode/decode-cost-fit.js";
import { AudioTrack } from "../../services/media/tracks/AudioTrack.js";
import { VideoTrack } from "../../services/media/tracks/VideoTrack.js";

// torrent-tv/meta#284: behaviour that must be the same before and after the
// codec names move into one table.
const media = { format: "matroska", durationSeconds: 60, startTimeSeconds: 0 };
const videoName = codecId => playbackDeclarations({
  tracks: [new VideoTrack({ trackNumber: 1, declaredIndex: 0, codecId, width: 640, height: 480, fps: 25 })], media
}).videoCodec;

test("video ids and FOURCCs keep their names", () => {
  const expected = {
    "V_MPEG4/ISO/AVC": "h264", avc1: "h264", avc3: "h264",
    "V_MPEGH/ISO/HEVC": "hevc", hvc1: "hevc", hev1: "hevc",
    V_MPEG1: "mpeg1video", V_MPEG2: "mpeg2video",
    "V_MPEG4/ISO/ASP": "mpeg4", "V_MPEG4/ISO/SP": "mpeg4", mp4v: "mpeg4",
    xvid: "mpeg4", XVID: "mpeg4", divx: "mpeg4", DIVX: "mpeg4", dx50: "mpeg4", DX50: "mpeg4",
    V_VP8: "vp8", V_VP9: "vp9", vp09: "vp9", V_AV1: "av1", av01: "av1",
    V_MJPEG: "mjpeg", MJPG: "mjpeg", JPEG: "mjpeg", V_FFV1: "ffv1", V_THEORA: "theora", MPG2: "mpeg2video"
  };
  for (const [id, name] of Object.entries(expected)) assert.equal(videoName(id), name, id);
});

test("an unknown video id is reported lower-cased", () => {
  assert.equal(videoName("V_UNKNOWN/THING"), "v_unknown/thing");
});

test("audio ids keep their names", () => {
  const expected = {
    A_AAC: "aac", A_AC3: "ac3", A_EAC3: "eac3", A_DTS: "dts", A_FLAC: "flac", A_OPUS: "opus",
    A_VORBIS: "vorbis", A_TRUEHD: "truehd", "A_MPEG/L3": "mp3", "A_MPEG/L2": "mp2", A_ALAC: "alac",
    mp4a: "aac", "ac-3": "ac3", "ec-3": "eac3", alac: "alac", opus: "opus", Opus: "opus",
    fLaC: "flac", flac: "flac",
    "A_AAC/MPEG4/LC": "aac", "A_PCM/INT/LIT": "pcm", "A_PCM/FLOAT/IEEE": "pcm", "A_UNKNOWN": "a_unknown"
  };
  for (const [codecId, name] of Object.entries(expected)) {
    assert.equal(AudioTrack.codecNameOf({ codecId }), name, codecId);
  }
});

test("a banner name wins over the container id and a bare sidecar falls back to its extension", () => {
  assert.equal(AudioTrack.codecNameOf({ codec: " AC3 ", codecId: "A_AAC" }), "ac3");
  assert.equal(AudioTrack.codecNameOf({}), "");
});

test("Matroska input declares each admitted codec by its exact id", () => {
  const idOf = codec => JSON.parse(matroskaTrackIdentity({ type: "video", codecId: codec }))[1];
  const expected = {
    avc1: "V_MPEG4/ISO/AVC", avc3: "V_MPEG4/ISO/AVC", h264: "V_MPEG4/ISO/AVC",
    hvc1: "V_MPEGH/ISO/HEVC", hev1: "V_MPEGH/ISO/HEVC", hevc: "V_MPEGH/ISO/HEVC",
    av01: "V_AV1", av1: "V_AV1", vp9: "V_VP9", vp8: "V_VP8", mjpeg: "V_MJPEG", ffv1: "V_FFV1",
    theora: "V_THEORA", jpeg2000: "V_JPEG2000", mpeg1video: "V_MPEG1", mpeg2video: "V_MPEG2",
    mpeg4: "V_MPEG4/ISO/ASP", FMP4: "V_MPEG4/ISO/ASP", XVID: "V_MPEG4/ISO/ASP", DIVX: "V_MPEG4/ISO/ASP",
    mp4a: "A_AAC", aac: "A_AAC", mp3: "A_MPEG/L3", mp2: "A_MPEG/L2", mp1: "A_MPEG/L1",
    "ac-3": "A_AC3", ac3: "A_AC3", "ec-3": "A_EAC3", eac3: "A_EAC3", Opus: "A_OPUS", opus: "A_OPUS",
    fLaC: "A_FLAC", flac: "A_FLAC", dts: "A_DTS", vorbis: "A_VORBIS", alac: "A_ALAC", truehd: "A_TRUEHD",
    pcm_s16le: "A_PCM/INT/LIT", pcm_u8: "A_PCM/INT/LIT", pcm_s24be: "A_PCM/INT/BIG", pcm_f32le: "A_PCM/FLOAT/IEEE",
    V_VP9: "V_VP9", A_AAC: "A_AAC"
  };
  for (const [codec, id] of Object.entries(expected)) assert.equal(idOf(codec), id, codec);
});

test("Matroska input stays exact: a codec it cannot declare throws, and identity follows the declared id", () => {
  assert.throws(() => matroskaTrackIdentity({ type: "video", codecId: "msmpeg4v3" }), /no Matroska declaration/);
  assert.throws(() => matroskaTrackIdentity({ type: "video", codecId: "M4S2" }), /no Matroska declaration/);
  assert.notEqual(matroskaTrackIdentity({ type: "video", codecId: "h264" }),
    matroskaTrackIdentity({ type: "video", codecId: "hevc" }));
  assert.equal(matroskaTrackIdentity({ type: "video", codecId: "avc1" }),
    matroskaTrackIdentity({ type: "video", codecId: "h264" }));
  assert.equal(matroskaTrackIdentity({ type: "video", codecId: "x", matroskaCodecId: "V_VP9" }),
    matroskaTrackIdentity({ type: "video", codecId: "vp9" }));
});

test("decodeFamilyOf prices the canonical names", () => {
  assert.equal(decodeFamilyOf({ codec: "h264" }), "h264");
  assert.equal(decodeFamilyOf({ codec: "hevc" }), "hevc");
  assert.equal(decodeFamilyOf({ codec: "hevc", bitDepth: 10 }), "hevc10");
  assert.equal(decodeFamilyOf({ codec: "mpeg4" }), "mpeg4");
  assert.equal(decodeFamilyOf({ codec: "mpeg2video" }), "mpeg2");
  assert.equal(decodeFamilyOf({ codec: "av1" }), "av1");
  assert.equal(decodeFamilyOf({ codec: "av1", bitDepth: 10 }), "h264");
  assert.equal(decodeFamilyOf({ codec: "msmpeg4v3" }), "h264");
  assert.equal(decodeFamilyOf({}), "h264");
});
