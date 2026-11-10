---
"@torrent-tv/proxy": patch
---

The proxy now uses whichever ffprobe on the host can read the stream details it needs, and stops at startup with one clear message when none can.
