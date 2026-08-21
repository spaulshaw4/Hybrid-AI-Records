import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..");
const CLIENT_FILE = /\.client\./;
const CLIENT_IMPORT = /from\s+['"][^'"]*\.client\.[^'"]+['"]|import\(\s*['"][^'"]*\.client\.[^'"]+['"]\s*\)/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(tsx|ts|jsx|js|mjs)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** Modules TanStack Start SSR-loads for GET /. */
const SSR_ENTRY_RELATIVE = [
  "start.ts",
  "server.ts",
  "router.tsx",
  "routes/__root.tsx",
  "routes/index.tsx",
];

describe("SSR import-protection (JAVASCRIPT-NEXTJS-1)", () => {
  it("does not add *.client.* files under src (denied on the server)", () => {
    const offenders = walk(SRC)
      .filter((file) => CLIENT_FILE.test(file.replace(/\\/g, "/")))
      .map((file) => relative(SRC, file).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });

  it("does not import *.client.* modules from GET / SSR entries", () => {
    const offenders: string[] = [];
    for (const rel of SSR_ENTRY_RELATIVE) {
      const source = readFileSync(join(SRC, rel), "utf8");
      if (CLIENT_IMPORT.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
