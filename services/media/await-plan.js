/** Subscribe before checking; pending source declarations have no elapsed deadline. */
export function waitForPlan({ read, subscribe, signal }) {
  return new Promise((resolve, reject) => {
    let done = false, running = false, changed = false, unsubscribe;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      unsubscribe?.();
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(value);
    };
    const aborted = () => finish(new DOMException("Playback preparation was cancelled.", "AbortError"));
    const pump = async () => {
      if (done || running) return;
      running = true;
      try {
        do {
          changed = false;
          const plan = await read();
          if (!plan.pending) finish(null, plan);
        } while (changed && !done);
      } catch (error) { finish(error); }
      finally {
        running = false;
        if (changed && !done) void pump();
      }
    };
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    try {
      unsubscribe = subscribe(result => {
        if (result?.kind === "cancelled") {
          if (result.reason === "source-forgotten") {
            const error = new Error("Playback source was forgotten.");
            error.code = "SOURCE_FORGOTTEN";
            finish(error);
          } else aborted();
          return;
        }
        changed = true;
        void pump();
      });
      if (done) unsubscribe?.();
      else void pump();
    } catch (error) { finish(error); }
  });
}
