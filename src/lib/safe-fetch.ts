/**
 * Defensive fetch helpers shared by the audio and video pipeline.
 *
 * Every network hop in the render pipeline (engine dispatch, polling, CDN
 * downloads, waveform decoding) goes through one of these so that:
 *
 *  1. The response object is confirmed to exist before `.ok` is read. A
 *     patched/aborted/proxied `fetch` can resolve `undefined`, and
 *     `undefined.ok` throws a bare `TypeError` that surfaces to the user as a
 *     blank screen instead of a readable failure.
 *  2. Every call is wrapped in try/catch, so transport drops become values
 *     rather than unhandled runtime exceptions.
 *  3. Failures return a clear, structured message naming the stage that broke.
 *
 * These are intentionally isomorphic (no server-only imports) so both browser
 * components and server helpers can use them.
 */

export type SafeFetchResult =
  | { ok: true; response: Response }
  | { ok: false; error: string; status: number | null };

/** Human-readable reason for a thrown/rejected transport error. */
export function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "the request timed out";
    }
    return error.message || "the network request failed";
  }
  return typeof error === "string" && error ? error : "the network request failed";
}

/**
 * Runs a fetch and never throws. The response is guaranteed to be a real
 * `Response` when `ok` is true; otherwise a structured error is returned.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  label = "Request",
): Promise<SafeFetchResult> {
  let response: Response | undefined;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const reason = describeFetchError(error);
    console.error(`[safe-fetch] ${label}: ${reason}`);
    return { ok: false, error: `${label} failed: ${reason}`, status: null };
  }

  // Guard against an undefined response before reading status properties.
  if (!response) {
    console.error(`[safe-fetch] ${label}: no response from server`);
    return { ok: false, error: `${label} failed: no response from server`, status: null };
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.clone().text()).slice(0, 400);
    } catch {
      detail = "";
    }
    console.error(`[safe-fetch] ${label}: HTTP ${response.status}`);
    return {
      ok: false,
      status: response.status,
      error: `${label} failed (${response.status})${detail ? `: ${detail}` : ""}`,
      };
  }

  return { ok: true, response };
}

/**
 * Same guarantees as {@link safeFetch}, but throws a single clear Error when
 * the call fails — for call sites that already own a try/catch and want the
 * happy-path `Response` inline.
 */
export async function fetchOrThrow(
  url: string,
  init: RequestInit = {},
  label = "Request",
): Promise<Response> {
  const result = await safeFetch(url, init, label);
  if (!result.ok) throw new Error(result.error);
  return result.response;
}

/** Fetches binary content (audio/video) with the same defensive guarantees. */
export async function fetchArrayBuffer(
  url: string,
  init: RequestInit = {},
  label = "Download",
): Promise<ArrayBuffer> {
  const response = await fetchOrThrow(url, init, label);
  try {
    return await response.arrayBuffer();
  } catch (error) {
    throw new Error(`${label} failed while reading data: ${describeFetchError(error)}`);
  }
}
