import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { extractUserFacingText, findVendorLeaks, isServerOnlyPath } from "@/lib/vendor-audit";

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(tsx|ts)$/.test(entry)) acc.push(full);
  }
  return acc;
}

const ROOTS = ["src/components", "src/routes", "src/lib", "src/hooks"];

describe("vendor-name audit", () => {
  it("no page or component shows a third-party vendor name", () => {
    const offenders: string[] = [];

    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const path = file.replace(/\\/g, "/");
        if (isServerOnlyPath(path)) continue;
        const source = readFileSync(file, "utf8");
        for (const text of extractUserFacingText(source)) {
          for (const leak of findVendorLeaks(text)) {
            offenders.push(`${path}: "${leak.term}" in — ${leak.excerpt}`);
          }
        }
      }
    }

    expect(offenders, `Vendor names leaked into user-visible copy:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });
});
