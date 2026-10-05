import { describe, expect, it } from "vitest";
import { sessionIdFromCreate } from "@/lib/create-session-id";

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
