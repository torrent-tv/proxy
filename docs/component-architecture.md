# Proxy components and how they talk

The proxy is seven components with different duties, not seven layers stacked in
dependency order: four domain components (torrent, media, encode, viewer), two
infrastructure components (transport, storage) and the server boundary. The
word "layer" in older notes and in `biome.json` means one of these components
and implies no dependency order. How the design was reached:
[meta `research/handover-architecture-refactor-2026-09-16.md`](https://github.com/torrent-tv/meta/blob/main/research/handover-architecture-refactor-2026-09-16.md).

This page owns the list of components, their duties and how they talk. The
modules inside each component directory are listed in [`layout.md`](layout.md);
the rules every change must keep are in [`../AGENTS.md`](../AGENTS.md).

## The seven components

The test that puts facts into one component: two facts belong together when they
are born together, die together and are addressed by one name
([meta `research/film-and-viewer-split-2026-09-03.md`](https://github.com/torrent-tv/meta/blob/main/research/film-and-viewer-split-2026-09-03.md)).

| component | owns | born / dies / addressed by | directory |
|---|---|---|---|
| transport | the connection and its channels, request framing, backpressure, delivery counters, liveness, association rotation and subscriptions | connection up / connection closed / connection id | `services/transport/` |
| server | the listening socket, routes, request parsing, response building, byte ranges, status codes, and the coordination of one operation | start / stop / port and request | `server.js`, `routes/`, `services/server/` |
| torrent | the swarm, pieces, what to request and in which order, what a torrent contains | torrent added / removed or idle / info hash | `services/torrent/` |
| storage | the shared memory and disk budget; the bytes of torrent pieces, segments, completed files and diagnostics | bytes admitted / evicted or removed / key and range | `services/storage/` |
| media | what a file says about itself: container, tracks, keyframe table, cue positions, playback plan | file read / file forgotten / file id | `services/media/` |
| encode | outputs, runs, encoders, the cut grid, what this machine can encode, the quality budget | a run: by the planner's decision / at the end of its interval / output key and run number | `services/encode/` |
| viewer | who the viewer is, what they asked for, at which quality, what they subscribe to, their link, and their own priority map | arrival / departure / viewer id | `services/viewer/` |

Details per component:

1. Transport delivers bytes to a peer and receives them. It works on events and
   subscriptions; a subscriber is anything callable. It knows nothing about
   viewers and passes the label the far end presented through without reading it.
2. Server answers questions. The data-channel handler forwards a parsed request
   to the local HTTP server, so HTTP and the data channel meet at one point.
   Components answer with operations (plain values in, plain values out); only
   the server turns a request into an operation call and back. A component that
   learns about HTTP status codes is the defect this boundary exists to prevent.
   Server operations coordinate one request and own no long-lived domain fact.
3. Torrent decides what to request, from whom and in which order. It reads the
   priority map.
4. Storage has one owner per set of bytes and one admission owner per device.
   `MachineBudget` recomputes memory and disk shares and tells each owner (piece
   store, `CompletedFiles`, `SegmentStore`, diagnostics); each owner evicts its own
   data by its own order, and there is no common eviction order. Policies:
   [`storage-architecture.md`](storage-architecture.md).
5. Media is not encoding: the same facts are read for subtitles, the audio-track
   menu and the playback plan when no encoder runs at all.
6. Encode owns outputs, runs, encoders and the cut grid, and reads the priority
   map and the requested output. The quality budget is part of encode; a
   viewer's link enters it as a plain number (the last reported Mbit/s), never as
   a reference to the viewer. Which existing output serves a viewer, in automatic
   and manual quality mode: `services/encode/quality/serving-output.js`.
7. Viewer produces the priority map that torrent, storage and encode read: the
   map is where the viewers stand and what they need, in units of material.

Nothing else lives under `services/`. Code that belongs to none of the seven and
is not the composition root is not covered by this design. Known exception:
`services/identity/installation-id.js` (the registry id of this installation,
used only by `bin/cli.js`) sits outside the seven directories and has no import
rule in `biome.json`.

## How components talk

1. Every fact has one owner.
2. A component does not import another component's concrete implementation and
   does not keep a reference to one.
3. A request for data or a command goes through a narrow interface handed in at
   construction. Example: media reads a byte range through the storage
   interface and does not know about disk, memory or the store's class; storage
   does not know that the bytes belong to a container or a torrent.
4. An event announces a change of state: a viewer arriving or leaving, a changed
   priority map, a closed segment, an encoder ending, bytes arriving. An event
   never replaces a request that needs an answer.
5. The owner of a fact announces its events. Subscribers are handed to it at
   construction in the composition root, so the composition root shows who
   listens to what. There is no shared event bus and none is planned.
6. Only the composition root (`server.js`, with `services/server/wire-outputs.js`
   as its subordinate assembler for the output graph) connects concrete
   implementations. It holds no behaviour: a need to add behaviour "to the
   assembly" means a duty that belongs to a component. Checked by
   `test/no-torrent/composition-root-states-no-facts.test.js` and
   `openspec/specs/composition-root/spec.md`.
7. A derived map or summary is not a second source of truth: it can be
   recomputed from the owner's facts and deleted without losing data.
8. Threads, processes, HTTP and WebRTC are boundaries of execution and delivery,
   not owners of domain facts.
9. Import rules in `biome.json` express each component's target boundary; files
   are not moved to satisfy an existing rule.

After every change check that:

1. every changed fact still has one owner;
2. no concrete implementation of another component appeared in imports or fields;
3. request and answer go through a narrow interface, and state changes through
   an event;
4. the component can be tested with stand-in interfaces without starting the
   other components;
5. the import rule expresses the component's target boundary rather than the
   current file layout.

## Facts with one owner that were once kept twice

1. The priority map's source of truth is the viewers' own maps, each in seconds
   of film. Merged maps own nothing and are a pure function of the viewers' maps
   (`mergeMaps` in `services/viewer/PriorityMap.js`). The file map merges every viewer of the file; torrent turns it
   into bytes (`services/torrent/demand/pieces.js`). The output map merges only the
   viewers of that output; encode turns it into its own segment numbers by the
   output's cut grid (`services/encode/SegmentDemand.js`). The output map cannot be
   derived from the file map, because merging loses who is on which output, so
   the merges are built by the viewer component. Stored copies (in
   `PriorityOrchestrator`, `SegmentDemand`, the torrent thread) are caches that are
   replaced whole on every publication.
2. The relation "viewer watches output" has one owner: the viewer holds the
   addresses (`OutputSpec` keys) of the outputs it watches, not the objects
   (`Viewer.outputs`). An output keeps no list of viewers; "is anybody on this
   output" is asked of the viewer registry (`Viewers.forOutput`). An output does not belong to a viewer: equal parameters are
   one output, and its production is reused.
3. A viewer is one object per person (`services/viewer/Viewers.js`), keyed by the
   consumer id the browser sends, minted once per film opened in the page. The
   quality mode (automatic or manual) belongs to the viewer and enters encode as
   a plain value; a page that does not state it is treated as manual.
4. `EncodedOutput` holds only what is born and dies with the output (`OutputSpec`,
   cut grid, format, tracks). Which runs are going is a fact of `EncodeRun` and the
   encode orchestrator; which segments are made is a fact of `SegmentStore`;
   `CoverageMap` is their projection. A segment waiting request is answered by
   the store's publication event, never by polling a file on a timer.
5. There is no film entity and no session entity. A film's parts are born at
   different times (the picture when playback starts, a soundtrack when the
   viewer switches to it, subtitles when they are turned on), die at different
   times and are addressed separately by the browser; everything film-shaped is
   keyed by the picture's file. What stops a soundtrack is having no listeners,
   not the picture ending.
6. An output's identity agrees within one proxy, not between proxies: a copied
   picture's bytes depend only on the source, a re-encoded one's on the encoder,
   its preset and the rate cap.
7. Film metadata (poster, title, description) is an answer from a third party
   about the file's identity. It lives on the server
   ([meta `research/metadata-enrichment-2026-09-30.md`](https://github.com/torrent-tv/meta/blob/main/research/metadata-enrichment-2026-09-30.md)), has its own route, cache
   and failure, and never travels inside the playback plan: the plan must be
   ready at once, and a missing poster never delays playback.
