# Proposal: Track inventory, audio selection and embedded-subtitle extraction

## Why

Torrents routinely carry several audio languages and embedded subtitles
(the owner's own test MKVs embed ASS subtitles), but the proxy exposed only
"the first audio track" and no subtitles at all: the probe reported a single
audio/video codec pair, the HLS session hard-mapped `0:a:0`, and embedded
subtitle streams were unreachable by the browser.

## What Changes

- **Probe returns the full track inventory**: `audioTracks` and
  `subtitleTracks` in the playback plan (type-relative index, codec,
  language, `title` metadata, default flag, `textBased` for subtitles) —
  parsed from the same single ffmpeg banner, no extra probe cost.
- **Audio selection**: `POST /api/transcode-sessions` accepts
  `audioTrackIndex`; the ffmpeg map becomes `0:a:N` and the index joins the
  session key (switch = fresh session via the existing restart machinery).
- **Embedded subtitle extraction**: `GET /api/subtitles` streams a chosen
  text subtitle track as WebVTT (ffmpeg `-map 0:s:N -f webvtt`). Image-based
  tracks (PGS/VobSub) are refused with 422. Known cost, accepted for v1:
  extraction reads the file to the last cue, so a cold torrent downloads
  sequentially while extracting.
- Announce log masks the tracker query string (passkey).

## Capabilities

### New Capabilities

- `track-selection`: track inventory in the plan, audio mapping, subtitle
  extraction.

### Modified Capabilities

- `observability`: announce log masks the passkey (delta note; the change is
  still unarchived so the edit lands there).

## Impact

- `services/playback-planner.js`, `services/hls-session-manager.js`,
  `routes/api/transcode-sessions/post.js`, new `routes/api/subtitles/get.js`,
  `server.js` wiring, `services/torrent-pool.js` (log masking).
- Pairs with the server-side `track-selection-ui` change; requires the usual
  ha-addon bump.
