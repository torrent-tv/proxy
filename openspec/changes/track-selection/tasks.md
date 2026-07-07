# Tasks: Track inventory, audio selection and embedded-subtitle extraction

## 1. Implementation

- [x] 1.1 playback-planner: input-section stream scanner (index, codec,
      language, title, default, textBased); `audioTracks`/`subtitleTracks`
      in the plan (verified against real ffmpeg output from the owner's MKV:
      hevc + flac + ass(eng) parsed, output streams excluded)
- [x] 1.2 hls-session-manager: `audioTrackIndex` option → `-map 0:a:N`,
      part of the session key; transcode-sessions route passthrough
- [x] 1.3 routes/api/subtitles/get.js: streaming WebVTT extraction, 422 on
      no-output tracks, kill on client disconnect, 30 min cap (verified:
      real cues extracted from the embedded ASS track over the LAN proxy)
- [x] 1.4 torrent-pool: mask the announce query string (passkey)

## 2. Release

- [ ] 2.1 `npm run patch` (2.9.26; needs npm 2FA), then ha-addon 0.2.48
- [ ] 2.2 After the addon updates: verify plan lists tracks and
      /api/subtitles serves VTT from the addon proxy
