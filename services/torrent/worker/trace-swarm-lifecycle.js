/** Record first-peer and metadata waits on the torrent worker's monotonic clock. */
export function beginSwarmLifecycleTrace(timing, trace, metadataAvailable, now = () => performance.now()) {
  if (timing.firstPeerAtMonotonic !== null) {
    trace("W3", "event", { outcome: "peer-already-connected" });
  } else if (timing.peerWaitStartedAt !== null) {
    trace("W3", "begin", { startedAt: timing.peerWaitStartedAt });
  }

  if (metadataAvailable) {
    trace("W4", "event", { outcome: "already-available" });
  } else if (timing.firstPeerAtMonotonic !== null) {
    timing.metadataWaitStartedAt = now();
    trace("W4", "begin", { startedAt: timing.metadataWaitStartedAt });
  }
}

export function noteSwarmDiscovery(timing, trace, endedAt) {
  if (timing.firstPeerAtMonotonic !== null || timing.peerWaitStartedAt !== null) return;
  timing.peerWaitStartedAt = endedAt;
  trace("W3", "begin", { startedAt: endedAt });
}

export function noteSwarmPeer(timing, trace, metadataAvailable, now = () => performance.now()) {
  if (timing.firstPeerAtMonotonic !== null) return;
  const endedAt = now();
  timing.firstPeerAtMonotonic = endedAt;
  if (timing.peerWaitStartedAt !== null) {
    trace("W3", "end", { startedAt: timing.peerWaitStartedAt, endedAt,
      durationMs: endedAt - timing.peerWaitStartedAt, outcome: "peer-connected" });
  } else {
    trace("W3", "event", { outcome: "peer-connected-before-trace" });
  }
  if (!metadataAvailable) {
    timing.metadataWaitStartedAt = endedAt;
    trace("W4", "begin", { startedAt: endedAt });
  }
}

export function noteSwarmMetadata(timing, trace, files, now = () => performance.now()) {
  const endedAt = now();
  if (timing.metadataWaitStartedAt !== null) {
    const startedAt = timing.metadataWaitStartedAt;
    timing.metadataWaitStartedAt = null;
    trace("W4", "end", { startedAt, endedAt, durationMs: endedAt - startedAt,
      outcome: "available", files });
  } else {
    trace("W4", "event", { outcome: "available", files });
  }
}
