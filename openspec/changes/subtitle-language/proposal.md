# Proposal: Proxy owns subtitle conversion + content-based language detection

## Why

Subtitle language was guessed only from the filename, so a file without a
language code (e.g. the Enola release's `.srt`) showed "Unknown", and the
owner specifically does not want Ukrainian and Russian confused. Reliable
detection needs an n-gram model on the actual text — which belongs on the
proxy (Node, node_modules, no per-browser payload, and the subtitle bytes are
right there) rather than in the browser.

## What Changes

- The proxy becomes the single owner of subtitle content: `GET /api/subtitles`
  now also serves EXTERNAL subtitle files (no `trackIndex`) — it reads the
  file, decodes its encoding (UTF-8 or Windows-1251, common for Russian
  `.srt`), and converts `.srt`/`.ass`/`.ssa` → WebVTT here. The browser no
  longer converts.
- The proxy detects the language from the full text with `franc` (n-gram /
  trigram, MIT), restricted to a curated set of plausible subtitle languages
  (distinguishes ru/uk/bg/sr and Latin languages; avoids short-text false
  positives like English→Scots), and reports it in `X-Subtitle-Language`
  (+ `X-Subtitle-Language-Name`). Embedded tracks detect from the first chunk
  of extracted VTT.
- The browser sets each track's language by priority: explicit code in the
  filename / container metadata (author intent) → proxy content detection →
  the film's audio-track language (forced-signs subs usually match the dub)
  → Unknown.

## Capabilities

### New Capabilities

- `subtitle-language`: proxy-side subtitle conversion, encoding handling and
  content-based language detection.

### Modified Capabilities

<!-- track-selection covered embedded extraction; this extends /api/subtitles
     to external files and adds detection. Its change is unarchived, so this
     lands as a new capability rather than a delta. -->

## Impact

- proxy: new `services/subtitle-convert.js`, `services/language-detect.js`
  (franc dep), extended `routes/api/subtitles/get.js`.
- server: `components/loading/loading.js` fetches VTT from the proxy for
  external subs (drops client-side conversion) and applies the language
  priority; browser franc/alphabet detection removed.
- Pairs with a server release; requires the ha-addon bump.
