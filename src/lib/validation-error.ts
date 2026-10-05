/**
 * Turns Zod, Pydantic, and API validation payloads into one readable sentence.
 * Zod 4's Error.message is a JSON dump of issues (`origin`, `code: too_big`);
 * FastAPI returns the same kind of list under `detail`. Neither belongs in the UI.
 */

export const LYRICS_MAX_CHARS = 5000;
export const LYRICS_SCHEMA_MESSAGE = "Lyrics cannot exceed 5,000 characters";
export const LYRICS_TOO_LONG_MESSAGE =
  "Lyrics are too long. Maximum allowed is 5,000 characters.";

const GENERIC_VALIDATION = "The track setup was rejected. Check the fields and try again.";

type IssueLike = {
  code?: unknown;
  type?: unknown;
  path?: unknown;
  loc?: unknown;
  message?: unknown;
  msg?: unknown;
};

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function looksLikeIssueDump(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return false;
  return /"(?:code|origin|loc|type)"\s*:/.test(trimmed);
}

function isIssue(value: unknown): value is IssueLike {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.message === "string" ||
    typeof record.msg === "string" ||
    typeof record.code === "string" ||
    typeof record.type === "string"
  );
}

function readIssues(input: unknown, depth = 0): IssueLike[] {
  if (depth > 4 || input == null) return [];
  if (typeof input === "string") {
    const parsed = tryParseJson(input);
    return parsed == null ? [] : readIssues(parsed, depth + 1);
  }
  if (input instanceof Error) {
    const withIssues = input as Error & { issues?: unknown };
    if (Array.isArray(withIssues.issues)) {
      const issues = withIssues.issues.filter(isIssue);
      if (issues.length > 0) return issues;
    }
    return readIssues(input.message, depth + 1);
  }
  if (Array.isArray(input)) {
    const issues = input.filter(isIssue);
    return issues.length > 0 ? issues : [];
  }
  if (typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  if (Array.isArray(record.issues)) {
    const issues = record.issues.filter(isIssue);
    if (issues.length > 0) return issues;
  }
  if ("detail" in record) {
    const fromDetail = readIssues(record.detail, depth + 1);
    if (fromDetail.length > 0) return fromDetail;
  }
  if ("error" in record) {
    const fromError = readIssues(record.error, depth + 1);
    if (fromError.length > 0) return fromError;
  }
  return isIssue(record) ? [record] : [];
}

function issueParts(issue: IssueLike): string[] {
  return [...(Array.isArray(issue.path) ? issue.path : []), ...(Array.isArray(issue.loc) ? issue.loc : [])].map(
    (part) => String(part),
  );
}

function issueField(issue: IssueLike): string {
  const parts = issueParts(issue);
  if (parts.some((part) => part === "lyrics" || part === "lyricsText" || part === "lyrics_to_sing")) {
    return "lyrics";
  }
  const skip = new Set(["body", "query", "string"]);
  return parts.filter((part) => !skip.has(part)).at(-1) ?? "";
}

function issueText(issue: IssueLike): string {
  if (typeof issue.message === "string" && issue.message.trim()) return issue.message.trim();
  if (typeof issue.msg === "string" && issue.msg.trim()) return issue.msg.trim();
  return "";
}

function isLyricsLengthIssue(issue: IssueLike): boolean {
  if (issueField(issue) !== "lyrics") return false;
  const code = `${issue.code ?? ""} ${issue.type ?? ""}`.toLowerCase();
  const text = issueText(issue).toLowerCase();
  return (
    code.includes("too_big") ||
    code.includes("too_long") ||
    code.includes("string_too_long") ||
    text.includes("too big") ||
    text.includes("too long") ||
    text.includes("at most") ||
    text.includes("cannot exceed") ||
    text.includes("maximum")
  );
}

function formatIssue(issue: IssueLike): string {
  if (isLyricsLengthIssue(issue)) return LYRICS_TOO_LONG_MESSAGE;
  const text = issueText(issue);
  if (text) return text;
  const field = issueField(issue);
  return field ? `${field} is invalid.` : GENERIC_VALIDATION;
}

function joinIssues(issues: IssueLike[]): string {
  const messages = [...new Set(issues.map(formatIssue).filter(Boolean))];
  return messages.join(" ") || GENERIC_VALIDATION;
}

/** One human-readable message. Validation JSON is never returned as-is. */
export function formatValidationError(input: unknown, fallback = GENERIC_VALIDATION): string {
  const issues = readIssues(input);
  if (issues.length > 0) return joinIssues(issues);

  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return fallback;
    if (looksLikeIssueDump(text)) return fallback;
    return text;
  }

  if (input instanceof Error) return formatValidationError(input.message, fallback);

  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if ("detail" in record && record.detail != null && record.detail !== input) {
      return formatValidationError(record.detail, fallback);
    }
    if ("error" in record && record.error != null && record.error !== input) {
      return formatValidationError(record.error, fallback);
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return formatValidationError(record.message, fallback);
    }
  }

  return fallback;
}
