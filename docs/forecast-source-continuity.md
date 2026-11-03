# Tail source work and continuity

`services/viewer/playback-readiness.js` schedules exact pieces through the
configured near window. For each mapped source piece after that window, it now
uses the piece's earliest required output-segment end as a deadline. The source
piece is charged once, even when two required tracks read the same bytes. Its
arrival contributes the same lateness condition as near-window work:

```text
startDelay >= sourceArrival - max(0, mediaDeadline - viewerPosition - reserve)
```

The tail source queue begins after the source work already scheduled in the
near window. It uses whole torrent pieces, current residence and planned
arrivals, and the same torrent-level service object used by the near schedule.
When multiple tracks need a piece, the earliest deadline owns it. Later uses
reuse that arrival and add no byte work. These are forecast service assignments;
they do not change the torrent's priority map or selection policy. An explicit
worker arrival remains authoritative for the piece it names.

The response reports one summary per source (`uniquePieces`, byte totals,
deadline span and latest arrival), so the diagnostics do not grow by one JSON
record per tail piece. The calculation still visits each mapped unique piece.

This mapped-source refinement visits the supplied tail segment maps and their
unique torrent pieces. Its work grows with that supplied map, even though the
aggregate processing and delivery estimates still scale with tracks. It does
not claim the previous source-and-track-only complexity bound for fully mapped
tails.

## Addressed and unmapped work

When every unfinished tail segment names valid source ranges, those ranges are
expanded to whole torrent pieces and scheduled at their segment deadlines. A
range already held or planned is reused. If any remaining segment lacks a
usable source map, the source keeps the aggregate estimate for the whole tail
instead of mixing an exact subset with a guessed remainder. The returned tail
entry states `addressed: false` and `estimatedAddress: "file-density"`; its
`missingBytes` and completion time remain visible. Missing addresses never
mean zero work. `ViewerRequests` currently supplies the active look-ahead and
piece 0, so the ordinary response uses this explicit aggregate fallback for
the distant suffix; the mapped deadline path applies when those segment maps
are present in the forecast input.

The fallback assumes the source file's measured byte density is spread over
the remaining media duration. That cannot bound arbitrary local density
changes: without a map for a segment, a large byte burst may occur before a
deadline even when the file-wide average predicts otherwise. The forecast does
not label this estimate exact and has no finite relative-error bound for that
case. It retains the density result as `diagnosticDelaySeconds` and marks the
full-film result `tail-source-addresses-unavailable` when the caller supplies a
full-tail profile; it does not publish the estimate as `delaySeconds` or a
predicted start time. Missing source identities are reported by track under
`unavailableTailTracks`. An input with no `tailSegments` profile still follows
the legacy aggregate estimate for now. `ViewerRequests` does not yet supply the
full-tail profile; that live projection is pending integration in
`OutputForecastGeometry`, so this partial branch is not complete. Exact mapped
source pieces add intermediate source deadlines, but the tail's processing and
delivery are still duration-level estimates and are conditional on measured
service rates continuing.

## Small schedule checks

The no-torrent cases in `test/no-torrent/forecast-tail.test.js` describe these
independent expectations:

1. A 10 KB middle piece at 1 KB/s arrives after its 9-second media deadline,
   so it holds playback by 3 seconds even though total source work is close to
   the full-film completion deadline.
2. Two tracks naming the same mapped bytes charge each whole torrent piece
   once.
3. Removing the tail maps retains an explicitly unaddressed aggregate byte
   estimate.
4. Moving the near-window boundary to 6 seconds includes the next mapped
   source bytes once in the tail; extending it to 12 seconds schedules the
   entire remaining film exactly and leaves no suffix work.
5. The saved 3,600-second suffix regression expects first-piece completion:
   `4 / 1.5 + (4 × 8,000,000) / 12,000,000 = 5.333333333…` seconds. The
   previously recorded 1,120-second result is historical evidence of the
   pre-fix serial-tail calculation, not a claim about the current result.

These checks use constant measured rates and synthetic segment maps. They do
not establish a bound for unknown source addresses, changing future rates,
variable tail processing, browser work, or delivery at every later segment
deadline. The forecast is conditional on its measured services continuing.
