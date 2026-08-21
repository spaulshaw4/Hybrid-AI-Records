// Captures the original Error out-of-band so server.ts can recover the stack
// when h3 has already swallowed the throw into a generic 500 Response.
//
// h3 logs the wrapped HTTPError via console.error *before* returning JSON.
// Listening only to window-style error events misses that, so we also record
// Error arguments passed to console.error.

let lastCapturedError: { error: unknown; at: number } | undefined;
const TTL_MS = 5_000;
let installed = false;

function record(error: unknown) {
  lastCapturedError = { error, at: Date.now() };
}

/** Called from request middleware when it catches an unhandled HTTPError. */
export function recordCapturedError(error: unknown) {
  record(error);
}

function installCapture() {
  if (installed) return;
  installed = true;

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    for (const arg of args) {
      if (arg instanceof Error) record(arg);
    }
    original(...args);
  };

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("error", (event) => record((event as ErrorEvent).error ?? event));
    globalThis.addEventListener("unhandledrejection", (event) =>
      record((event as PromiseRejectionEvent).reason),
    );
  }
}

installCapture();

export function consumeLastCapturedError(): unknown {
  if (!lastCapturedError) return undefined;
  if (Date.now() - lastCapturedError.at > TTL_MS) {
    lastCapturedError = undefined;
    return undefined;
  }
  const { error } = lastCapturedError;
  lastCapturedError = undefined;
  return error;
}
