import { formatValidationError } from "@/lib/validation-error";

/** Session id from POST /api/tracks/create. Any one alias is enough. */
export type CreateSessionBody = {
  sessionId?: unknown;
  session_id?: unknown;
  id?: unknown;
  track_id?: unknown;
};

/** Thrown when create fails or an OK body has no session id. Message is safe to show. */
export const CREATE_RESPONSE_ERROR = "CreateResponseError";

export function isCreateResponseError(error: unknown): error is Error {
  return error instanceof Error && error.name === CREATE_RESPONSE_ERROR;
}

function createResponseError(message: string): Error {
  const error = new Error(message);
  error.name = CREATE_RESPONSE_ERROR;
  return error;
}

function createBodyRecord(data: unknown): CreateSessionBody & Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return data as CreateSessionBody & Record<string, unknown>;
}

/**
 * Text for a non-OK create body.
 * A string `detail` is returned unchanged. A FastAPI issue list becomes one sentence.
 */
export function messageFromCreateFailure(data: unknown, status: number): string {
  const body = createBodyRecord(data);
  const errorMessage = body.detail || body.error || body.message || `Server returned ${status}`;
  if (typeof errorMessage === "string") return errorMessage;
  const formatted = formatValidationError(errorMessage, "");
  if (formatted.trim()) return formatted;
  return JSON.stringify(errorMessage);
}

/**
 * Session id from a create response.
 * Checks HTTP status before any id alias. The missing-id error is only for an OK body.
 */
export function sessionFromCreateResponse(
  res: { ok: boolean; status: number },
  data: unknown,
): string {
  if (!res.ok) {
    throw createResponseError(messageFromCreateFailure(data, res.status));
  }
  try {
    return sessionIdFromCreate(createBodyRecord(data));
  } catch (error) {
    if (error instanceof Error) throw createResponseError(error.message);
    throw error;
  }
}

export function sessionIdFromCreate(res: CreateSessionBody | null | undefined): string {
  const body = res ?? {};
  const sessionId = String(body.sessionId || body.session_id || body.id || body.track_id || "").trim();
  if (!sessionId) {
    throw new Error("Create did not return a session id.");
  }
  return sessionId;
}
