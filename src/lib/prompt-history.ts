/**
 * Style & Sound Prompt version history.
 *
 * Every meaningful edit of the prompt box is recorded locally so a producer can
 * jump back to an earlier wording with one click. Device-local only.
 */
export const PROMPT_HISTORY_KEY = "hybrid.studio.promptHistory";
export const PROMPT_HISTORY_MAX = 25;

export type PromptVersion = {
  id: string;
  text: string;
  at: number;
};

function isVersion(value: unknown): value is PromptVersion {
  const v = value as PromptVersion | null;
  return Boolean(v && typeof v.id === "string" && typeof v.text === "string");
}

export function readPromptHistory(): PromptVersion[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PROMPT_HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isVersion).slice(0, PROMPT_HISTORY_MAX);
  } catch {
    return [];
  }
}

function persist(next: PromptVersion[]): PromptVersion[] {
  try {
    window.localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — history stays in memory for this session */
  }
  return next;
}

/**
 * Records a prompt version. No-ops for empty text or when it matches the newest
 * entry; a newest entry that is a strict prefix of the new text is replaced so
 * typing bursts collapse into one version.
 */
export function recordPromptVersion(text: string): PromptVersion[] {
  const clean = text.trim();
  if (clean.length < 3) return readPromptHistory();

  const list = readPromptHistory();
  const newest = list[0];
  if (newest && newest.text === clean) return list;

  const entry: PromptVersion = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `ph-${Date.now()}`,
    text: clean,
    at: Date.now(),
  };

  const collapse = newest && (clean.startsWith(newest.text) || newest.text.startsWith(clean));
  const next = collapse ? [entry, ...list.slice(1)] : [entry, ...list];
  return persist(next.slice(0, PROMPT_HISTORY_MAX));
}

export function deletePromptVersion(id: string): PromptVersion[] {
  return persist(readPromptHistory().filter((v) => v.id !== id));
}

export function clearPromptHistory(): PromptVersion[] {
  return persist([]);
}
