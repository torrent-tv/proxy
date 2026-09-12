# @torrent-tv/torrent-contents

What is in one torrent: which of its files carry a picture, and which files
belong to which picture — as its sound, its subtitles or its images.

**It exists because the answer was being given twice.** The proxy decided it in
`services/torrent/`, and the browser decided it again in
`public/domain/torrent-parser.js` and once more inside its picker. The three had
already diverged: measured 2026-09-12, the browser offered `.dat` as video and
the proxy did not count it, so on such a torrent the person was offered a file
the proxy did not consider a picture — and the count of pictures decides whether
a sidecar with a name in common with nothing can still belong to the only video
there is.

One fact needs one owner. It is published as a package rather than settled on
one side because both sides genuinely need the answer AT ONCE: the proxy states
what to fetch, and the browser shows the list of episodes the instant a
`.torrent` is opened, before a proxy has even been chosen.

## What it is

- `files.js` — which extensions carry a picture, sound, subtitles or an image;
  which files of a torrent belong to one video; the pairing rules, taken from
  what releases actually do and measured against a collection of 137 real
  torrents.
- `naming.js` — what a file's own path says about the track in it: its
  language, the flags a releaser wrote, and who made it. The grammar is the
  union of what Plex, Jellyfin, Kodi, Bazarr and OpenSubtitles produce.
- `Contents.js` — the two above, held instead of recomputed: the file list, the
  pictures with what belongs to each, the order a person reads them in, and
  what belongs to nothing.

## What it is not

It reads no bytes, waits on no swarm and knows nothing about ffmpeg, HTTP or a
browser. It is a function of a torrent's own list of names, which is why it can
run in both places and be tested outright.

It holds nothing about a FILM either — a poster, a title, a description are
answers from a third party about an identity read from a file's own bytes, and
they belong to whatever caches those.

## Use

```js
import { TorrentContents } from "@torrent-tv/torrent-contents";

const contents = new TorrentContents({ files: torrent.files, name: torrent.name });
contents.items;                 // every picture, in reading order, with its parts
contents.sidecarsOf(fileIndex); // what belongs beside one picture
contents.leftovers;             // what belongs to no picture
```
