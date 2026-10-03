# Playback start forecast

For resource r, measured service is S_r(t) = rate_r * t. New observations
replace the conditional future rate; polling cannot invent acceleration,
exponential recovery or a new physical measurement.

Source work uses the file's measured byte density, missing local byte ranges
and the observed torrent download rate. Shared input ranges are downloaded
once. Files on the same torrent share a queue; distinct torrents use distinct
observed services. Local input reading is included in effective processing
speed, rather than charged again as a separate disk or memory delay.

Each output's remaining processing work subtracts progress only within its
actual live run intervals. Initial video rates use existing codec/size/encoder
calibration. Initial audio rates use short packaged per-codec measurements and
sample work (encoding) or encoded bytes (copying). Actual output progress
replaces these initial rates. That rate is the run's processing speed: film
made over the run's own working time, with the time its input waited for the
swarm and the time it was stopped taken out (`RunClock`, fed by the stream
route, which marks each wait of a run's input read). The download is charged
once, by the source service, and not a second time inside the processing rate. Startup is charged once, separately from processing
throughput, and disappears once actual run progress establishes processing.

Input arrival and processing overlap. With arrival time D(m), processing rate
e and previous completion C, completion for an interval [a,b] is

    max(C + (b-a)/e, sup_m(D(m) + (b-m)/e)).

Between service boundaries these functions are linear, so only endpoints are
needed. Client delivery follows production and shares the observed link queue.
Measured client ranges and prepared media establish each track's deadlines.

The minimum start delay for this conditional trajectory is

    max(0, max_j(completion_j - presentation_deadline_j)).

This covers the remaining finite movie, including rates below real time. Slow
positive service gives a finite preproduction delay; it is not rejected by a
browser-capacity threshold or a capped search. Observed supply-interruption
coverage is held in prepared proxy media and client media, without requiring
the browser to hold it all.

Critical review: future rates can change, average byte density is an initial
mapping rather than an exact packet index, initial audio sample-work scaling
does not model every decoder's nonlinear cost, and client receive/append time
is not separately measured. These are approximation limits, not hidden weights.
Actual progress, segment sizes and link observations refine the prediction.
The client countdown uses elapsed local monotonic time; expiration cannot
authorize playback. Only the proxy's readiness and real track coverage can.

Zero service, missing media facts and a genuine timestamp gap remain explicit
noncomputable states. The UI reports their causes instead of an estimating
placeholder or a fabricated duration.

## Continuity is decided in exact time

The forecast lives in the viewer component (`services/viewer/`), because what
it predicts is how the viewer's browser will play; the request operation
(`ViewerRequests`) is handed it by `wire-outputs.js`.

1. **The file states integers.** A piece's media is read as presentation
   intervals in the integer ticks of each track's timescale
   (`readPresentationRanges`, `services/encode/segment-formats/mp4-boxes.js`).
   Intervals are joined there only where they touch or overlap; the format
   states what the samples say and nothing about browsers.
2. **One function places a piece.** The position written into `tfdt` when a
   piece is served and the position its coverage is read at both come from
   `readTrackEdits`, which converts the movie-timescale edit into track ticks
   with one stated rounding. The reader and the writer cannot disagree.
3. **Seconds from the page are exact fractions.** A buffered range, a position
   or a cut time arrives as a JavaScript number, which is a binary fraction;
   `services/viewer/media-time.js` converts it to that fraction exactly. No unit
   is chosen. A buffered range is widened by `REPORTED_TIME_ERROR`, the bound of
   Chromium's three truncations to whole microseconds, so that it denotes every
   exact time the report can stand for.
4. **The join rule holds in every engine.** The Media Source specification
   leaves the threshold to the implementation, so a gap counts as joined only
   when Chromium, Gecko and WebKit all join it: twice the gap within the two
   ranges' longest frames since a keyframe (Gecko's fuzz), and the gap within
   2002/24000 s (WebKit's `timeFudgeFactor`). Chromium's own bound follows from
   the first. Old iOS without Media Source plays HLS in a closed player, and
   nothing is derived for it.

Seconds appear again only for rates, schedules and the answer.

## A piece is finished when its frames reach its cut

A closed non-final fragment is reusable only if the end of its last frame, on
every track, reaches its muxer's cut less `SEGMENT_CUT_TIME_DELTA_SECONDS`,
the delta the muxer is configured with. That is a fact of production, so no
browser frame allowance is used to decide completeness. For explicit cuts the
closure channel is CSV: its reference packet end has not lost the fraction of
a movie tick that MP4's empty edit loses. The first reference packet's time is
recovered from that end minus the first piece's exact sample span (the first
CSV start is zero even after a seek), and is added to the relative cut times
handed to FFmpeg. Comparisons use integer microseconds, as FFmpeg's segment
muxer does. A stored piece without this closure reading carries the upper
uncertainty of its empty edit, read from the movie and track timescales.

The last frame must still reach the cut on every track. No playable media, a
missing full frame, or a failed rename remains a publication failure. Such a
failure stops the run, records that cause and releases its claimed interval;
the existing repeated-start failure limit applies to subsequent attempts. A
refused file cannot stay claimed while the encoder finishes the whole film.

The encoding decides completeness
(`encode/piece-completeness.js`): `EncodeRuns` judges a closed file before it is
published, and judges a stored piece left by an earlier process when the
forecast asks for it, taking a short one off the disk. The segment store keeps
the bytes and the media intervals read from them and judges nothing. Interrupted
fragments are therefore never served or counted, so the production schedule
treats their media as unfinished work. The final fragment uses its actual media
end rather than the container's approximate duration.
