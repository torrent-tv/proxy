# subtitle-language — delta spec

## ADDED Requirements

### Requirement: Proxy converts subtitles and reports the language
`GET /api/subtitles` SHALL serve every subtitle as WebVTT and report the
detected language in `X-Subtitle-Language` (ISO 639-1) and
`X-Subtitle-Language-Name`. It SHALL handle two modes: an embedded track
(`trackIndex` given — extracted via ffmpeg) and an external subtitle file (no
`trackIndex` — the file is read, its encoding decoded, and `.srt`/`.ass`/
`.ssa` converted to WebVTT on the proxy). A leading BOM SHALL be stripped and
Windows-1251 bytes decoded when the file is not valid UTF-8.

#### Scenario: External Russian .srt without a filename code
- **WHEN** an external `.srt` whose name has no language code is requested
- **THEN** the response is WebVTT and `X-Subtitle-Language` is `ru`

#### Scenario: Ukrainian is not reported as Russian
- **WHEN** the subtitle text is Ukrainian
- **THEN** the detected language is `uk`, not `ru`

#### Scenario: Unsupported format
- **WHEN** an image-based or unconvertible subtitle is requested
- **THEN** the proxy responds 422

### Requirement: Detection is confidence-gated
Language detection SHALL be restricted to a curated set of plausible subtitle
languages and SHALL return no language (omit the header) when the text is too
short or undetermined, rather than emitting a wrong guess.

#### Scenario: Too little text
- **WHEN** the subtitle has only a few characters
- **THEN** no language header is set (the browser falls back to filename or
  audio language)
