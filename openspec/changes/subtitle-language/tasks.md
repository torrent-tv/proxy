# Tasks: Proxy subtitle conversion + language detection

## 1. Proxy

- [x] 1.1 `services/subtitle-convert.js`: encoding-aware decode (UTF-8/BOM/
      Windows-1251) + srt/ass/ssa → WebVTT (ported, BOM-stripped)
- [x] 1.2 `services/language-detect.js`: franc restricted to a curated
      ISO 639-3→639-1 allowlist; null when undetermined/too short
- [x] 1.3 `routes/api/subtitles/get.js`: external-file mode (read, decode,
      convert, detect) + `X-Subtitle-Language(-Name)` on both modes
- [x] 1.4 franc dependency added to proxy
- [x] 1.5 Verified: unit-tested convert+detect (ru/uk/en/de, short→null) and
      the route end-to-end on the real Enola .srt (→ ru, 19 cues)

## 2. Server (browser)

- [x] 2.1 External subs fetch VTT from `/api/subtitles` (no client convert)
- [x] 2.2 Language priority: filename code → X-Subtitle-Language → audio-track
      language → und; embedded track uses metadata → header → audio
- [x] 2.3 Removed the client-side convertSubtitleToVtt call + dead import

## 3. Release

- [ ] 3.1 Proxy publish (OTP) + ha-addon bump + server patch
- [ ] 3.2 Field-check: Enola external .srt labels "Russian"; a Ukrainian sub
      labels "Ukrainian"; embedded tracks keep their metadata language
