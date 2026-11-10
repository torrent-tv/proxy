# avi-xvid-bframes.avi

A 3 second, 64x64, 10 fps test picture (`testsrc2`) coded with the libxvid encoder, B pictures
enabled, no audio. Read by the `libxvid` case of `test/no-torrent/avi-reordered-local.test.js`,
because the darwin-arm64 `ffmpeg-static` has no libxvid encoder.

- Command: `ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=64x64:rate=10 -t 3 -c:v libxvid -bf 2 avi-xvid-bframes.avi`
- ffmpeg: `ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/`, built with gcc 8 (Debian 8.3.0-6);
  the binary of npm `ffmpeg-static@5.3.0` on Linux x64 (GitHub Actions runner `ubuntu-26.04`, 2026-11-10).
- sha256: `01dfde0fb241cbfd7e2fbe86abac5e7b547c7f3583fd42e6c7652609a4d96e36`
- Size: 35892 bytes. 28 pictures, `IBBPBPBBPBBPIBBPBPBBPBPBIBBP`; stream FOURCC `xvid` (lower case).
