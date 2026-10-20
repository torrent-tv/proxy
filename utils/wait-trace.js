/** Bounded, opt-in startup observations. No torrent or application imports. */
export class SourceWaitTrace {
  constructor({ emit, now = () => performance.now() }) {
    Object.assign(this, { emit, now, sources: new Map(), requests: new WeakMap() });
  }

  write(context, event, fields = {}) {
    this.emit({ version: 1, clock: "proxy-main", wait: context.wait, attempt: context.attempt,
      operation: context.operation, event, at: this.now(), ...fields });
  }

  remember(sourceKey, context) {
    if (typeof sourceKey !== "string" || !sourceKey) return;
    for (const [key, value] of this.sources) if (this.now() - value.seen > 60_000) this.sources.delete(key);
    if (this.sources.size >= 64 && !this.sources.has(sourceKey)) this.sources.delete(this.sources.keys().next().value);
    this.sources.set(sourceKey, { ...context, seen: this.now() });
  }

  source(sourceKey, event, fields = {}) {
    const context = this.sources.get(sourceKey);
    if (!context || this.now() - context.seen > 60_000) return;
    this.write({ ...context, operation: null }, event, { sourceKey, ...fields });
  }

  install(app) {
    app.addHook("onRequest", async (req, reply) => {
      const wait = req.headers["x-ttv-wait-trace"];
      const operation = req.headers["x-ttv-wait-operation"];
      const attempt = Number(req.headers["x-ttv-wait-attempt"]);
      if (typeof wait !== "string" || !/^[a-zA-Z0-9.-]{1,80}$/.test(wait) ||
        typeof operation !== "string" || !/^b[0-9]{1,12}$/.test(operation) ||
        !Number.isSafeInteger(attempt) || attempt < 0) return;
      const context = { wait, attempt, operation, startedAt: this.now() };
      this.requests.set(req, context);
      this.write(context, "http-start", { method: req.method, path: req.url,
        requestId: req.headers["x-ttv-forwarded-request-id"] ?? req.id });
      let finished = false;
      const end = outcome => {
        if (finished) return;
        finished = true;
        this.write(context, "http-end", { outcome, status: reply.statusCode, duration: this.now() - context.startedAt });
      };
      reply.raw.once("finish", () => end("finished"));
      reply.raw.once("close", () => end(reply.raw.writableFinished ? "finished" : "closed"));
    });
    app.addHook("preHandler", async req => {
      const context = this.requests.get(req);
      if (!context) return;
      const match = /^\/api\/sources\/([^/?]+)/.exec(req.url);
      const sourceKey = req.body?.sourceKey ?? req.query?.sourceKey ?? (match ? decodeURIComponent(match[1]) : null);
      this.remember(sourceKey, context);
      this.write(context, "http-handler", { sourceKey });
    });
    app.addHook("preSerialization", async (req, _reply, payload) => {
      const context = this.requests.get(req);
      if (context) {
        this.remember(payload?.sourceKey, context);
        this.write(context, "http-serialize");
      }
      return payload;
    });
    app.addHook("onSend", async (req, _reply, payload) => {
      const context = this.requests.get(req);
      if (context) this.write(context, "http-send");
      return payload;
    });
  }
}
