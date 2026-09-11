// Next.js server-start hook. Node runtime only: opens storage, recovers
// abandoned work from any previous process, and starts exactly one
// acquisition loop per server instance. Storage is never initialized from a
// request path or page render — this hook is the single eager entry point.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as typeof globalThis & {
    __velvarrAcquisitionLoopStarted?: boolean;
  };
  // Dev hot-reload can re-run register() in the same process; opening
  // storage and starting the loop must happen exactly once.
  if (g.__velvarrAcquisitionLoopStarted) return;
  g.__velvarrAcquisitionLoopStarted = true;
  try {
    // Dynamic imports keep node:sqlite and friends out of every other
    // runtime this hook is invoked in.
    const [
      { initializeStorage, recoverAbandonedWork },
      { startAcquisitionLoop, shutdownAcquisition },
    ] = await Promise.all([
      import("./server/storage.ts"),
      import("./server/acquisition.ts"),
    ]);
    initializeStorage();
    recoverAbandonedWork();
    startAcquisitionLoop();
    // SIGTERM (container stop) / SIGINT (ctrl-c): stop scheduling, give an
    // in-flight pass a bounded grace window, release claims, close storage.
    // once() per signal plus the coalescing inside shutdownAcquisition make
    // repeated signals safe; the explicit exit is what lets the process
    // actually terminate despite the listening HTTP server (and reaps a
    // pass still stuck past the grace window).
    const onSignal = () => {
      void shutdownAcquisition().then(({ forced }) => {
        if (forced) {
          console.error(
            "[velvarr] shutdown grace expired; in-flight pass abandoned for boot-time reconciliation",
          );
        }
        process.exit(0);
      });
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  } catch (e) {
    // Visible in logs without leaking secrets (error messages here are the
    // sanitized AppError texts), and never rethrown: a broken boot must not
    // crash-loop the server. Durable work stays in SQLite for the next boot;
    // no retry happens in this process.
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[velvarr] startup failed, acquisition loop not started: ${message}`,
    );
  }
}
