/**
 * Local Firecrawl scrape smoke test. Writes markdown to scraped-output.md
 * so you can inspect a page without an API/database roundtrip.
 *
 * Usage:
 *   bun scripts/test-firecrawl.mjs
 *   bun scripts/test-firecrawl.mjs https://example.com
 *
 * Optional: FIRECRAWL_API_KEY in .env.local or .env (higher rate limits).
 */
import { Firecrawl } from "firecrawl";
import { config } from "dotenv";
import { writeFileSync } from "node:fs";

config({ path: ".env.local" });
config({ path: ".env" });

const url = process.argv[2] || "https://example.com";
const apiKey = process.env.FIRECRAWL_API_KEY?.trim();

if (!apiKey) {
  console.error(
    "Missing FIRECRAWL_API_KEY. Add it to .env.local (https://www.firecrawl.dev/app/api-keys), then retry.",
  );
  process.exit(1);
}

const firecrawl = new Firecrawl({ apiKey });

async function run() {
  console.log(`Testing Firecrawl extraction: ${url}`);
  try {
    const scrapeResult = await firecrawl.scrape(url, {
      formats: ["markdown"],
    });
    console.log("Scrape successful!");

    writeFileSync("scraped-output.md", scrapeResult.markdown || "");
    console.log("Saved result to scraped-output.md");
  } catch (error) {
    console.error("Firecrawl error:", error);
    process.exitCode = 1;
  }
}

run();
