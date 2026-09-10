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
      { startAcquisitionLoop },
    ] = await Promise.all([
      import("./server/storage.ts"),
      import("./server/acquisition.ts"),
    ]);
    initializeStorage();
    recoverAbandonedWork();
    startAcquisitionLoop();
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
