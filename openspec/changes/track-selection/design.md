# Design: Track inventory, audio selection and embedded-subtitle extraction

## Context

The probe already captures the full ffmpeg `-i` banner; the HLS session
manager already restarts ffmpeg per (source, file, settings) key; the
`/stream` route already drives prioritised sequential download. All three
features ride those mechanisms.

## Goals / Non-Goals

**Goals:** expose every track; select audio server-side; deliver embedded
text subtitles as WebVTT.

**Non-Goals:** seamless (no-restart) audio switching via HLS alternate
renditions; image-based subtitles (PGS/VobSub — needs OCR or burn-in);
subtitle extraction that avoids downloading the file (impossible: cues are
interleaved across the whole container).

## Decisions

1. **Parse tracks from the existing probe output** (zero extra probe cost).
   The scanner reads only the Input section — ffmpeg prints Stream lines for
   the null output too, which would duplicate every track (caught against
   real output). Titles come from each stream's `title` metadata line.
2. **Audio switch = new session.** `audioTrackIndex` joins the session key;
   the old session dies via the existing idle TTL. Reuses the proven
   seek-restart machinery instead of building HLS alternate renditions;
   the cost is a few seconds' gap on switch — acceptable v1.
3. **Extraction as a streaming route.** ffmpeg writes WebVTT to stdout piped
   into the HTTP response; the first stdout chunk decides 200-vs-422 (a
   non-text track dies before producing output). Client disconnect kills
   ffmpeg; a 30-minute hard cap guards dead swarms. The transport layer's
   60 s request timeout must be raised per-request by the browser (done in
   the paired server change).
4. **Accepted v1 cost:** extraction reads to the last cue → cold torrents
   download while extracting. For the transcode path the file downloads
   anyway; for direct play this is extra traffic the viewer opted into by
   picking a subtitle.

## Risks / Trade-offs

- [Extraction competes with playback for piece priority] → both readers move
  the 8 MB critical window; sequential download serves both. Field-watch; if
  playback stalls appear, throttle extraction reads later.
- [Stream-line format drift across ffmpeg versions] → regex kept permissive;
  a parse miss degrades to an empty inventory (menus simply do not appear).
