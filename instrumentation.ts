// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { queueWorker } = await import('@/lib/generation-queue-worker.server');
    queueWorker.start();
    console.log('[INSTRUMENTATION] Background generation queue worker initialized on server boot.');
  }
}
