// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  // The Python daemon_poller on the workstation owns the user_vaults queue: it
  // is the only worker that actually renders audio. Running the in-process
  // TypeScript worker alongside it means both poll the same `pending` rows
  // without atomic claims, and whichever wins writes enlinement blueprints then
  // strands the session at `processing` forever.
  //
  // Set HYBRID_ENABLE_INPROCESS_WORKER=true only when the Python daemon is
  // stopped, e.g. for local frontend development without the workstation.
  if (process.env.HYBRID_ENABLE_INPROCESS_WORKER !== 'true') {
    console.log('[INSTRUMENTATION] In-process queue worker disabled; daemon_poller.py owns the queue.');
    return;
  }

  const { queueWorker } = await import('@/lib/generation-queue-worker.server');
  queueWorker.start();
  console.log('[INSTRUMENTATION] Background generation queue worker initialized on server boot.');
}
