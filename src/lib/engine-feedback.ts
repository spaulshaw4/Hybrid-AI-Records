/**
 * Implicit feedback on a finished render — no rating buttons.
 *
 * The engine already logs which stems it offered and which it staged for every
 * render. This closes the loop by telling it how the result was treated, so the
 * selection weights can be fitted to real behaviour instead of judgement:
 *
 * - `export` — downloaded, a positive on its own
 * - `play`   — scored by fraction heard; a skip in the first third is the
 *              negative example the fit needs, a full playthrough is positive
 *
 * Every call is best-effort. Feedback must never interrupt playback or block a
 * download, so failures are swallowed and `keepalive` lets the request outlive
 * the page during an unload.
 */

const FEEDBACK_URL = "/api/tracks/feedback";

export type EngineFeedbackEvent = "export" | "play";

/** Below this fraction heard, the backend treats the play as a rejection. */
export const SKIP_FRACTION = 0.33;

type FeedbackBody = {
  session_id: string;
  event: EngineFeedbackEvent;
  position_sec?: number;
  duration_sec?: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * POST one verdict. Resolves false rather than throwing, so callers can fire
 * and forget from inside an event handler.
 */
export async function sendEngineFeedback(body: FeedbackBody): Promise<boolean> {
  const sessionId = body.session_id?.trim();
  if (!sessionId) return false;
  try {
    const res = await fetch(FEEDBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        event: body.event,
        position_sec: isFiniteNumber(body.position_sec) ? body.position_sec : 0,
        duration_sec: isFiniteNumber(body.duration_sec) ? body.duration_sec : 0,
      }),
      // Survives the page going away mid-request (tab close, navigation).
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** A download is an unambiguous positive; no playback numbers needed. */
export function reportEngineExport(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  void sendEngineFeedback({ session_id: sessionId, event: "export" });
}

/**
 * Report how much of a track was heard.
 *
 * Deliberately one call per listen rather than one per pause: a listener who
 * scrubs or pauses repeatedly would otherwise bury the signal under a dozen
 * partial rows. Callers use {@link createPlayReporter} to get that guarantee.
 */
export function reportEnginePlay(
  sessionId: string | null | undefined,
  positionSec: number,
  durationSec: number,
): void {
  if (!sessionId) return;
  if (!isFiniteNumber(durationSec) || durationSec <= 0) return;
  void sendEngineFeedback({
    session_id: sessionId,
    event: "play",
    position_sec: positionSec,
    duration_sec: durationSec,
  });
}

export type PlayReporter = {
  /** Call on timeupdate. Tracks the furthest point actually reached. */
  observe: (positionSec: number, durationSec: number) => void;
  /** Reached the end: a full playthrough. */
  complete: (durationSec: number) => void;
  /** Listening is over (unmount, source change, tab hidden). Reports once. */
  flush: () => void;
  /** Starting a different track — report the previous one, then reset. */
  reset: () => void;
};

/**
 * Collects playback progress and emits exactly one verdict per listen.
 *
 * Tracks the furthest position reached rather than the current one, so pausing
 * near the end still reports as heard, while a genuine early skip reports as a
 * negative.
 */
export function createPlayReporter(
  getSessionId: () => string | null | undefined,
): PlayReporter {
  let maxHeard = 0;
  let duration = 0;
  let sent = false;
  let started = false;

  const emit = (position: number) => {
    if (sent) return;
    const sessionId = getSessionId();
    if (!sessionId || duration <= 0 || !started) return;
    sent = true;
    reportEnginePlay(sessionId, position, duration);
  };

  return {
    observe(positionSec, durationSec) {
      if (isFiniteNumber(durationSec) && durationSec > 0) duration = durationSec;
      if (isFiniteNumber(positionSec) && positionSec > maxHeard) {
        maxHeard = positionSec;
        // Any real progress counts as having started; guards against a
        // metadata-only load reporting a 0-second "skip".
        if (positionSec > 0.25) started = true;
      }
    },
    complete(durationSec) {
      if (isFiniteNumber(durationSec) && durationSec > 0) duration = durationSec;
      started = true;
      maxHeard = duration;
      emit(duration);
    },
    flush() {
      emit(maxHeard);
    },
    reset() {
      emit(maxHeard);
      maxHeard = 0;
      duration = 0;
      sent = false;
      started = false;
    },
  };
}
