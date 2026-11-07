import assert from "node:assert/strict";
import test from "node:test";

// torrent-tv/meta#284: the one codec table. These tests need the planned
// services/media/tracks/codec-names.js and fail until it exists.
const MPEG4_FOURCCS = ["FMP4", "XVID", "DIVX", "DX50", "MP4V", "M4S2", "MP4S"];
const names = () => import("../../services/media/tracks/codec-names.js");

test("codec-names exports the three lookups", async () => {
  const module = await names();
  for (const name of ["videoCodecName", "audioCodecName", "matroskaIdOf"]) {
    assert.equal(typeof module[name], "function", `${name} is exported`);
  }
});

test("every MPEG-4 FOURCC, in any case, is named mpeg4", async () => {
  const { videoCodecName } = await names();
  for (const fourcc of MPEG4_FOURCCS) {
    for (const spelled of [fourcc, fourcc.toLowerCase()]) {
      assert.equal(videoCodecName(spelled), "mpeg4", spelled);
    }
  }
});

test("matroskaIdOf is the exact reverse of the canonical names the table produces", async () => {
  const { videoCodecName, matroskaIdOf } = await names();
  assert.equal(matroskaIdOf(videoCodecName("V_MPEG4/ISO/AVC")), "V_MPEG4/ISO/AVC");
  assert.equal(matroskaIdOf("hevc"), "V_MPEGH/ISO/HEVC");
  assert.equal(matroskaIdOf("mpeg4"), "V_MPEG4/ISO/ASP");
});
