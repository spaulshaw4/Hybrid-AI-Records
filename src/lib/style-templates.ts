/**
 * Named Style & Sound Prompt templates, persisted locally so a producer can
 * save the current prompt text and insert it again later.
 */
export const STYLE_TEMPLATE_KEY = "hybrid.studio.styleTemplates";
export const STYLE_TEMPLATE_MAX = 30;

export type StyleTemplate = {
  id: string;
  name: string;
  text: string;
  at: number;
};

function isTemplate(value: unknown): value is StyleTemplate {
  const t = value as StyleTemplate | null;
  return Boolean(t && typeof t.id === "string" && typeof t.name === "string" && typeof t.text === "string");
}

export function readStyleTemplates(): StyleTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STYLE_TEMPLATE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTemplate).slice(0, STYLE_TEMPLATE_MAX);
  } catch {
    return [];
  }
}

function persist(next: StyleTemplate[]): StyleTemplate[] {
  try {
    window.localStorage.setItem(STYLE_TEMPLATE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — templates stay in memory for this session */
  }
  return next;
}

/** Saves under a name, replacing any existing template with the same name. */
export function saveStyleTemplate(name: string, text: string): StyleTemplate[] {
  const clean = name.trim();
  const template: StyleTemplate = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `tpl-${Date.now()}`,
    name: clean,
    text: text.trim(),
    at: Date.now(),
  };
  const rest = readStyleTemplates().filter((t) => t.name.toLowerCase() !== clean.toLowerCase());
  return persist([template, ...rest].slice(0, STYLE_TEMPLATE_MAX));
}

export function deleteStyleTemplate(id: string): StyleTemplate[] {
  return persist(readStyleTemplates().filter((t) => t.id !== id));
}
