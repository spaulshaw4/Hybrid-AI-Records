import { describe, expect, it } from "vitest";
import {
  isCreateResponseError,
  sessionFromCreateResponse,
  sessionIdFromCreate,
} from "@/lib/create-session-id";

const ALIASES = ["sessionId", "session_id", "id", "track_id"] as const;

describe("sessionIdFromCreate", () => {
  it("accepts a create body that is missing only one alias", () => {
    for (const missing of ALIASES) {
      const body: Record<string, string> = {};
      for (const key of ALIASES) {
        if (key !== missing) body[key] = "ht_alias_ok";
      }
      expect(sessionIdFromCreate(body)).toBe("ht_alias_ok");
    }
  });

  it("accepts a create body that carries only one alias", () => {
    for (const only of ALIASES) {
      expect(sessionIdFromCreate({ [only]: "ht_only_one" })).toBe("ht_only_one");
    }
  });

  it("throws when every session id alias is missing", () => {
    expect(() => sessionIdFromCreate({})).toThrow("Create did not return a session id.");
    expect(() => sessionIdFromCreate({ sessionId: "  ", session_id: "", id: null })).toThrow(
      "Create did not return a session id.",
    );
  });
});

function thrownCreate(res: { ok: boolean; status: number }, data: unknown): Error {
  try {
    sessionFromCreateResponse(res, data);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected sessionFromCreateResponse to throw");
}

describe("sessionFromCreateResponse", () => {
  it("surfaces a 400 detail string and does not use the session-id error", () => {
    const error = thrownCreate(
      { ok: false, status: 400 },
      { detail: "prompt exceeds 5000 characters" },
    );
    expect(isCreateResponseError(error)).toBe(true);
    expect(error.message).toBe("prompt exceeds 5000 characters");
    expect(error.message).not.toBe("Create did not return a session id.");
  });

  it("surfaces a 500 detail string as-is", () => {
    const error = thrownCreate({ ok: false, status: 500 }, { detail: "could not persist job" });
    expect(error.message).toBe("could not persist job");
  });

  it("keeps a string detail even when it looks like a validation dump", () => {
    const detail = JSON.stringify([
      { loc: ["body", "prompt"], msg: "hidden", type: "value_error" },
    ]);
    const error = thrownCreate({ ok: false, status: 400 }, { detail });
    expect(error.message).toBe(detail);
  });

  it("turns a FastAPI detail array into a readable sentence", () => {
    const error = thrownCreate(
      { ok: false, status: 422 },
      {
        detail: [
          {
            type: "string_too_long",
            loc: ["body", "title"],
            msg: "String should have at most 120 characters",
          },
        ],
      },
    );
    expect(error.message).toBe("String should have at most 120 characters");
    expect(error.message).not.toContain("loc");
    expect(error.message).not.toContain("string_too_long");
  });

  it("falls back to the status when a failed body has no message", () => {
    const error = thrownCreate({ ok: false, status: 500 }, {});
    expect(error.message).toBe("Server returned 500");
    expect(error.message).not.toBe("Create did not return a session id.");
  });

  it("accepts a 200 body that only has session_id", () => {
    expect(sessionFromCreateResponse({ ok: true, status: 200 }, { session_id: "ht_only_session" })).toBe(
      "ht_only_session",
    );
  });

  it("returns session_id when a 200 body has success true", () => {
    expect(
      sessionFromCreateResponse({ ok: true, status: 200 }, { success: true, session_id: "ht_success_true" }),
    ).toBe("ht_success_true");
  });

  it("throws a 200 success false detail and does not return a session id", () => {
    const error = thrownCreate(
      { ok: true, status: 200 },
      { success: false, detail: "queue rejected the prompt", session_id: "ht_should_not_return" },
    );
    expect(isCreateResponseError(error)).toBe(true);
    expect(error.message).toBe("queue rejected the prompt");
    expect(error.message).not.toBe("Create did not return a session id.");
  });

  it("throws a 200 success false error and does not return a session id", () => {
    const error = thrownCreate(
      { ok: true, status: 200 },
      { success: false, error: "engine refused the job", sessionId: "ht_should_not_return" },
    );
    expect(error.message).toBe("engine refused the job");
    expect(error.message).not.toBe("ht_should_not_return");
  });

  it("prefers a string detail over error on a 200 success false body", () => {
    const error = thrownCreate(
      { ok: true, status: 200 },
      { success: false, detail: "detail wins", error: "error loses", session_id: "ht_should_not_return" },
    );
    expect(error.message).toBe("detail wins");
  });

  it("throws a 200 error string even when the status is ok", () => {
    const error = thrownCreate(
      { ok: true, status: 200 },
      { error: "HeartMuLa generation failed: timeout", session_id: "ht_should_not_return" },
    );
    expect(error.message).toBe("HeartMuLa generation failed: timeout");
  });

  it("stringifies an object error on a 200 body", () => {
    const errorBody = { reason: "timeout", attempt: 2 };
    const error = thrownCreate({ ok: true, status: 200 }, { error: errorBody });
    expect(error.message).toBe(JSON.stringify(errorBody));
  });

  it("throws the session-id error when a 200 body has no id", () => {
    const error = thrownCreate({ ok: true, status: 200 }, { status: "pending" });
    expect(error.message).toBe("Create did not return a session id.");
  });
});
