/** Session id from POST /api/tracks/create. Any one alias is enough. */
export type CreateSessionBody = {
  sessionId?: unknown;
  session_id?: unknown;
  id?: unknown;
  track_id?: unknown;
};

export function sessionIdFromCreate(res: CreateSessionBody | null | undefined): string {
  const body = res ?? {};
  const sessionId = String(body.sessionId || body.session_id || body.id || body.track_id || "").trim();
  if (!sessionId) {
    throw new Error("Create did not return a session id.");
  }
  return sessionId;
}
