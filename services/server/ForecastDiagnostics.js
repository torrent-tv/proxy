/** Aggregates playback-forecast work for the existing once-a-minute log. */
export class ForecastDiagnostics {
  #logger;
  #costs = { since: Date.now(), polls: 0, ms: 0, maxMs: 0, times: new Map() };

  constructor({ logger }) {
    this.#logger = logger;
  }

  note(ms, reasons) {
    const costs = this.#costs;
    costs.polls += 1;
    costs.ms += ms;
    costs.maxMs = Math.max(costs.maxMs, ms);
    for (const reason of reasons) costs.times.set(reason, (costs.times.get(reason) ?? 0) + 1);
    const now = Date.now();
    if (now - costs.since < 60_000) return;
    this.#logger.info(`start forecasts in ${((now - costs.since) / 1000).toFixed(1)}s: ${costs.polls}, ` +
      `${Math.round(costs.ms)}ms in all, ${(costs.ms / costs.polls).toFixed(1)}ms each, longest ${Math.round(costs.maxMs)}ms; ` +
      `times of a track's pieces: ${[...costs.times].map(([reason, count]) => `${reason} ${count}`).join(", ")}`);
    Object.assign(costs, { since: now, polls: 0, ms: 0, maxMs: 0, times: new Map() });
  }
}
