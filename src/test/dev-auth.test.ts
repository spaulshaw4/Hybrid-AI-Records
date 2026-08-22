import { describe, expect, it } from "vitest";
import {
  DEV_TEST_TOKEN_BALANCE,
  DEV_TEST_USER,
  DEV_TEST_USER_UUID,
  isDevAuthBypass,
} from "@/lib/dev-auth";

describe("dev auth bypass", () => {
  it("is off in production builds", () => {
    expect(isDevAuthBypass({ DEV: true, PROD: true, NODE_ENV: "development" })).toBe(false);
    expect(isDevAuthBypass({ DEV: false, PROD: true, NODE_ENV: "production" })).toBe(false);
    expect(isDevAuthBypass({ DEV: false, PROD: false, NODE_ENV: "production" })).toBe(false);
  });

  it("is on in Vite dev even if NODE_ENV is production", () => {
    expect(isDevAuthBypass({ DEV: true, PROD: false, NODE_ENV: "production" })).toBe(true);
  });

  it("is on when NODE_ENV is development", () => {
    expect(isDevAuthBypass({ DEV: true, PROD: false, NODE_ENV: "development" })).toBe(true);
    expect(isDevAuthBypass({ DEV: false, PROD: false, NODE_ENV: "development" })).toBe(true);
  });

  it("exposes the local test identity and a 10-token balance", () => {
    expect(DEV_TEST_USER).toEqual({
      id: "dev-test-user",
      email: "test@hybridengine.ai",
    });
    expect(DEV_TEST_TOKEN_BALANCE).toBe(10);
    expect(DEV_TEST_USER_UUID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
