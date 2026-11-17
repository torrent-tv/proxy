# Proposal: The address of "what was given" names the picture

## Why

A page that opens a second file keeps its consumer id and its generation, so
the viewer's record of what was given in that generation outlives the first
picture. The record's address is the asked height and the segment; it has no
picture in it. A request for segment N of picture B was therefore answered by
what had been given for segment N of picture A, and when A's output was gone,
from A's stored piece (torrent-tv/meta#470: the viewer saw one episode's
picture under another episode's sound).

## What Changes

- `Assignments` addresses a record by the picture, the asked height and the
  segment: `addressOf(pictureKey, askedHeight, segmentIndex)`. `give`,
  `givenFor` and `highestGiven` take the picture key.
- The picture key is the material identity `isSameMaterial` compares, returned
  by one exported function beside it in `services/encode/quality/serving-output.js`.
- `Renditions` (the step route) and `ViewerRequests.noteAnsweredDirectly` (the
  picture's own route) pass the picture key of the output the request names.
- No compatibility for the old record shape.

Out of scope: whether the page starts a new generation or consumer on a file
change; the hls.js audio-offset step.
