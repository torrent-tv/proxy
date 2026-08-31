# Container & Track architecture

Domain → Application → Interface, per RFC 9559 (Matroska) and ISO/IEC 14496-12 (MP4).

## Two axes, and what is NOT a third

Everything here is placed on exactly two axes: **which container** a track lives
in, and **what kind of track** it is (video / audio / subtitle). A file lying
beside the video — a dub as `<name>.mka`, subtitles as `<name>.ass` — is not a
third kind of anything:

- a `.mka` **is** Matroska. `ContainerFactory` sniffs it, `MatroskaContainer`
  reads its `TrackEntry` list, and out comes an `AudioTrack` with its language,
  title and flags. It differs from the picture's own file only in having no
  video track. The same holds for `.m4a` and `Mp4Container`;
- "external" is therefore not a TYPE. It is the answer to WHERE a track's bytes
  are, and that is torrent knowledge — which this layer must not have
  (`ContainerFactory`: no torrent knowledge; `ContainerOrchestrator`:
  transport-agnostic). The pairing of a sidecar file with a picture lives in
  `services/sidecar-files.js`, and the numbered list a viewer chooses from lives
  in `services/audio-inventory.js`. Both are pure and both are application-layer.

A class called `ExternalSubtitleFile` used to sit in `tracks/` asserting the
opposite. It did not extend `ContainerTrack`, duplicated four of its fields, and
was imported by nothing; it was deleted rather than extended. Nothing replaced
it — a subtitle file beside the video is a `TextSubtitleTrack` whose bytes are
read from another file, and a raw `.srt` needs no `Container` subclass because
it has no track table and no index to read: the whole file is the payload, and
`SubtitleController` already reads it as such.

## Layers

```mermaid
flowchart TB
  subgraph Domain
    C[Container<br/>abstract<br/>RFC9559 / 14496-12]
    MC[MatroskaContainer]
    MpC[Mp4Container]
    AC[AviContainer]
    CT[ContainerTrack<br/>isEnabled/isDefault/language]
    VT[VideoTrack]
    AT[AudioTrack]
    ST[SubtitleTrack]
    TST[TextSubtitleTrack<br/>S_TEXT/UTF8 tx3g wvtt]
    IST[ImageSubtitleTrack<br/>PGS VobSub subp]
    C --> MC & MpC & AC
    CT --> VT & AT & ST
    ST --> TST & IST
    MC & MpC & AC -- readTracks --> CT
  end
  subgraph Application
    CF[ContainerFactory<br/>detect 16 bytes]
    CO[ContainerOrchestrator<br/>cache + getTracks/getKeyframeIndex]
    SO[SubtitleOrchestrator<br/>wrap subtitle-cues.js]
    SF[sidecar-files.js<br/>which file goes with which]
    AI[audio-inventory.js<br/>one flat numbering]
    CF --> CO
    CO --> SO
    SF --> AI
    CO --> AI
  end
  subgraph Interface
    PC[PlaybackController]
    SC[SubtitleController]
    R1[routes/api/playback-plan]
    R2[routes/api/subtitles]
    PC --> R1
    SC --> R2
    CO --> PC
    SO --> SC
  end
```

## Class responsibilities (spec-grounded)

| Class | Spec section | Fields | Not responsible |
|---|---|---|---|
| `ContainerTrack` | RFC9559 TrackEntry common + ISO 14496-12 tkhd/mdhd/hdlr/elng | `trackNumber`, `declaredIndex`, `codecId`, `language`/`languageBcp47` (MUST rule), `name`, `isEnabled` (0xB9 / track_enabled), `isDefault`+`declaresDefault` (0x88) | Type-specific flags |
| `VideoTrack` | RFC9559 Video, ISO 14496-12 tkhd width/height, stsd | `width/height/display*`, `fps`, `isHdr`, `bitDepth` | Subtitle flags |
| `AudioTrack` | RFC9559 FlagOriginal 0x55AE, FlagCommentary 0x55AF, FlagVisualImpaired 0x55AC | `isOriginal/isCommentary/isVisualImpaired`, `channels/samplingFrequency` | FlagForced |
| `SubtitleTrack` | RFC9559 FlagForced 0x55AA (subtitle-only), FlagHearingImpaired 0x55AB | `isForced/isHearingImpaired`, `clusterPositions`/`samples` | Video dims |
| `TextSubtitleTrack` | `S_TEXT/UTF8, S_TEXT/ASS, tx3g, wvtt` | `toVtt()` convertible | Image tracks |
| `sidecar-files.js` | — (torrent naming) | which files of a torrent are one picture's sound and subtitles | what is inside them |
| `audio-inventory.js` | RFC9559 audio flags, merged against ffmpeg's numbering | one flat number per soundtrack → `(fileIndex, 0:a:N)` | display labels |
| `ImageSubtitleTrack` | `S_HDMV/PGS, S_VOBSUB, subp, clcp` | kept for `declaredIndex` alignment | Conversion |
| `MatroskaContainer` | RFC9559 SeekHead, Tracks, Cues, Clusters | single Tracks walk for all types, EBML via `ebml-reader.js` | HTTP |
| `Mp4Container` | ISO 14496-12 moov/trak/tkhd/mdhd/hdlr/elng/stbl | `alternate_group` grouping, packed language, `tx3g` forced bits | Torrent |
| `AviContainer` | RIFF AVI idx1 | `AVIIF_KEYFRAME` keyframe times | Tracks beyond video |

`VideoTrack` never carries `isForced` — spec states FlagForced "Applies only to subtitles". Placing it in base would pollute video with irrelevant state.

## Orchestrators & Controllers

- `ContainerFactory.create({readRange,fileSize})` — sniffs 16 bytes, returns precise `Container` subclass. No torrent knowledge.
- `ContainerOrchestrator` — per-file cache (`sourceKey:fileIndex`), `getTracks()` / `getKeyframeIndex()`. Transport-agnostic.
- `SubtitleOrchestrator` — wraps `torrent-worker/subtitle-cues.js` (`planFor`, `cuesHeldFor`, `warmSubtitleCues`) behind `ContainerTrack` abstraction. Routes depend on this, not on worker directly.
- `PlaybackController` / `SubtitleController` — thin interface adapters; `routes/api/*` delegate to them, handle HTTP headers (`X-Subtitle-Language`, `X-Subtitle-Cursor`) only.

## Legacy

`services/container-index/` remains as internal detail used by `container/*`. Direct imports from routes are deprecated — use `orchestrators/` and `controllers/` instead.

## Flags matrix

| Flag | Matroska ID | Applies to | Base or subclass |
|---|---|---|---|
| `FlagEnabled` | 0xB9 default 1 | all | `ContainerTrack` |
| `FlagDefault` | 0x88 default 1 | all | `ContainerTrack` (`declaresDefault`) |
| `Language` | 0x22B59C | all | `ContainerTrack` |
| `LanguageBCP47` | 0x22B59D MUST | all | `ContainerTrack` |
| `FlagForced` | 0x55AA | subtitle only | `SubtitleTrack` |
| `FlagHearingImpaired` | 0x55AB | subtitle | `SubtitleTrack` |
| `FlagVisualImpaired` | 0x55AC | audio (descriptive) + subtitle | `AudioTrack`/`SubtitleTrack` |
| `FlagOriginal` | 0x55AE | audio | `AudioTrack` |
| `FlagCommentary` | 0x55AF | audio | `AudioTrack` |
| `track_enabled` | tkhd 0x000001 | all | `ContainerTrack` |
| `alternate_group` | tkhd | audio/video alternates | `ContainerTrack.alternateGroup` |
| `elng` | 14496-12 §8.4.6 | all | `ContainerTrack.languageBcp47` |
