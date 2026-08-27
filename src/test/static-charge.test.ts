import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("static charge / discharge wiring", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("LogoutButton uses useStaticDischarger", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/LogoutButton.tsx"),
      "utf8",
    );
    expect(source).toContain("useStaticDischarger");
    expect(source).toContain("dischargeSessionState");
    expect(source).toContain("Discharging Session");
  });

  it("AppErrorBoundary offers emergency discharge", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/AppErrorBoundary.tsx"),
      "utf8",
    );
    expect(source).toContain("handleEmergencyDischarge");
    expect(source).toContain("Perform Emergency Discharge");
    expect(source).toContain("dischargeSessionState");
  });

  it("account page mounts LogoutButton", () => {
    const source = readFileSync(join(process.cwd(), "src/routes/account.tsx"), "utf8");
    expect(source).toContain("LogoutButton");
    expect(source).toContain("Sign Out");
  });

  it("root installs static charge monitor", () => {
    const source = readFileSync(join(process.cwd(), "src/routes/__root.tsx"), "utf8");
    expect(source).toContain("installStaticChargeMonitor");
  });

  it("dischargeBrowserCaches removes sb- auth keys", async () => {
    const store = new Map<string, string>();
    store.set("sb-xyz-auth-token", "secret");
    store.set("hybrid.studio.pending", "{}");
    store.set("har_language", "en");

    vi.stubGlobal("window", {
      localStorage: {
        get length() {
          return store.size;
        },
        key: (i: number) => [...store.keys()][i] ?? null,
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
      sessionStorage: {
        length: 0,
        key: () => null,
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
      dispatchEvent: () => true,
    });

    const { dischargeBrowserCaches } = await import("@/lib/static-charge");
    dischargeBrowserCaches({ aggressive: false });
    expect(store.has("sb-xyz-auth-token")).toBe(false);
    expect(store.has("hybrid.studio.pending")).toBe(false);
    expect(store.get("har_language")).toBe("en");
  });
});
