/**
 * WebKit-safe media helpers — never let teardown throw into the JS thread.
 */

/** Pause + detach a source without throwing (iOS Safari is strict here). */
export function safeReleaseMediaElement(el: HTMLMediaElement | null | undefined): void {
  if (!el) return;
  try {
    el.pause();
  } catch {
    /* ignore */
  }
  try {
    el.removeAttribute("src");
    // Empty <source> children if present
    while (el.firstChild) el.removeChild(el.firstChild);
  } catch {
    /* ignore */
  }
  try {
    el.load();
  } catch {
    /* ignore */
  }
}

/** Close an AudioContext without freezing WebKit on already-closed contexts. */
export async function safeCloseAudioContext(
  ctx: AudioContext | null | undefined,
): Promise<void> {
  if (!ctx) return;
  try {
    if (ctx.state !== "closed") await ctx.close();
  } catch {
    /* ignore */
  }
}

/** Swallow play() rejections that WebKit surfaces as unhandled (autoplay / abort). */
export function safePlay(el: HTMLMediaElement): Promise<void> {
  try {
    const result = el.play();
    if (result && typeof result.then === "function") {
      return result.catch((error: unknown) => {
        const name = error instanceof DOMException ? error.name : "";
        if (name === "AbortError" || name === "NotAllowedError") return;
        console.warn("[safe-media] play() rejected", error);
      });
    }
  } catch (error) {
    console.warn("[safe-media] play() threw", error);
  }
  return Promise.resolve();
}
