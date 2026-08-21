/**
 * Engine-level circuit breaker.
 *
 * The HTTP layer in `apiframe.server.ts` already retries transient gateway
 * errors with jittered backoff. This breaker sits one level higher: it tracks
 * how often a *render engine* (MiniMax 2.6 vs ElevenLabs Music) fails end to
 * end, and once an engine trips it is skipped entirely for a cooldown window
 * so a brief is switched to the healthy engine immediately instead of burning
 * minutes on retries that are going to time out anyway.
 */
import { ELEVENLABS_MAX_SECONDS } from "@/lib/engine-routing";
import type { RenderEngine } from "@/lib/render-engines";

type BreakerState = {
  failures: number;
  /** Epoch ms the breaker opened, 0 when closed. */
  openedAt: number;
  lastReason: string | null;
};

const envInt = (name: string, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

function config() {
  return {
    failureThreshold: envInt("ENGINE_BREAKER_FAILURES", 3, 1, 20),
    cooldownMs: envInt("ENGINE_BREAKER_COOLDOWN_MS", 60_000, 5_000, 900_000),
    attempts: envInt("ENGINE_DISPATCH_ATTEMPTS", 2, 1, 5),
    baseDelayMs: envInt("ENGINE_DISPATCH_BASE_MS", 800, 50, 10_000),
    maxDelayMs: envInt("ENGINE_DISPATCH_MAX_MS", 6_000, 100, 60_000),
  };
}

const states = new Map<RenderEngine, BreakerState>();

function state(engine: RenderEngine): BreakerState {
  let existing = states.get(engine);
  if (!existing) {
    existing = { failures: 0, openedAt: 0, lastReason: null };
    states.set(engine, existing);
  }
  return existing;
}

/** True while the engine is tripped and inside its cooldown window. */
export function isEngineOpen(engine: RenderEngine): boolean {
  const s = state(engine);
  if (s.openedAt === 0) return false;
  if (Date.now() - s.openedAt < config().cooldownMs) return true;
  // Cooldown elapsed — half-open: let the next call probe the engine.
  s.openedAt = 0;
  s.failures = Math.max(0, config().failureThreshold - 1);
  return false;
}

export function recordEngineSuccess(engine: RenderEngine) {
  const s = state(engine);
  s.failures = 0;
  s.openedAt = 0;
  s.lastReason = null;
}

export function recordEngineFailure(engine: RenderEngine, reason: string) {
  const s = state(engine);
  s.failures += 1;
  s.lastReason = reason;
  const { failureThreshold } = config();
  if (s.failures >= failureThreshold && s.openedAt === 0) {
    s.openedAt = Date.now();
    console.error("[engine-breaker] opened", { engine, failures: s.failures, reason });
  }
}

export function engineBreakerSnapshot() {
  const { failureThreshold, cooldownMs } = config();
  return (["minimax", "elevenlabs"] as const).map((engine) => {
    const s = state(engine);
    const open = s.openedAt > 0 && Date.now() - s.openedAt < cooldownMs;
    return {
      engine,
      open,
      failures: s.failures,
      failureThreshold,
      retryAfterMs: open ? cooldownMs - (Date.now() - s.openedAt) : 0,
      lastReason: s.lastReason,
    };
  });
}

export function resetEngineBreakers() {
  states.clear();
}

/** The other engine, when policy allows it to carry this brief. */
function alternateEngine(
  engine: RenderEngine,
  durationSeconds: number | undefined,
): RenderEngine | null {
  if (engine === "hybrid") return "minimax";
  if (engine === "elevenlabs") return "minimax";
  // ElevenLabs can only stand in for short clips.
  if (durationSeconds !== undefined && durationSeconds <= ELEVENLABS_MAX_SECONDS) {
    return "elevenlabs";
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Full-jitter exponential backoff. */
function backoff(attempt: number, baseMs: number, maxMs: number) {
  return Math.floor(Math.random() * Math.min(maxMs, baseMs * 2 ** (attempt - 1)));
}

export type EngineDispatchOutcome<T> = {
  engine: RenderEngine;
  value: T;
  /** Set when the breaker moved the brief to the other engine. */
  switchedNote?: string;
};

/**
 * Run a render through the breaker.
 *
 * - Skips an engine whose breaker is open and goes straight to the alternate.
 * - Retries the chosen engine with exponential backoff before giving up.
 * - Falls over to the alternate engine on repeated failure.
 * - Throws a short, safe error when no engine can serve the brief.
 */
export async function dispatchWithBreaker<T>(options: {
  engine: RenderEngine;
  durationSeconds?: number;
  run: (engine: RenderEngine) => Promise<T>;
}): Promise<EngineDispatchOutcome<T>> {
  const { attempts, baseDelayMs, maxDelayMs } = config();
  const alternate = alternateEngine(options.engine, options.durationSeconds);

  const order: RenderEngine[] = isEngineOpen(options.engine) && alternate
    ? [alternate, options.engine]
    : alternate
      ? [options.engine, alternate]
      : [options.engine];

  let switchedNote: string | undefined;
  if (order[0] !== options.engine) {
    switchedNote = `${options.engine === "minimax" ? "MiniMax 2.6" : "ElevenLabs Music"} is temporarily unavailable — this render was switched to ${order[0] === "minimax" ? "MiniMax 2.6" : "ElevenLabs Music"}.`;
  }

  let lastError: unknown = null;

  for (const engine of order) {
    if (engine !== order[0] && isEngineOpen(engine)) continue;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(backoff(attempt - 1, baseDelayMs, maxDelayMs));
      try {
        const value = await options.run(engine);
        recordEngineSuccess(engine);
        return {
          engine,
          value,
          ...(engine === options.engine
            ? switchedNote
              ? { switchedNote }
              : {}
            : {
                switchedNote: `${options.engine === "minimax" ? "MiniMax 2.6" : "ElevenLabs Music"} kept failing — this render was completed on ${engine === "minimax" ? "MiniMax 2.6" : "ElevenLabs Music"}.`,
              }),
        };
      } catch (error) {
        lastError = error;
        const reason = error instanceof Error ? error.message : String(error);
        recordEngineFailure(engine, reason);
        console.warn("[engine-breaker] attempt failed", { engine, attempt, attempts, reason });
      }
    }
  }

  console.error("[engine-breaker] all engines exhausted", {
    engine: options.engine,
    reason: lastError instanceof Error ? lastError.message : String(lastError),
  });
  throw new Error(
    "Both render engines are unavailable right now. No token was spent — please try again in a minute.",
  );
}
