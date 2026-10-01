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
replaces these initial rates. Startup is charged once, separately from processing
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
placeholder or a fabricated duration. Small coded-frame joins follow measured
frame durations and Chromium's continuous-track rule, not a hand-picked margin.
