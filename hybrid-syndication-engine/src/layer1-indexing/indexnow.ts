export interface IndexNowResult {
  ok: boolean;
  status: number | null;
  body: string;
}

export async function submitToIndexNow(urls: string[]): Promise<IndexNowResult> {
  const host = new URL(process.env.PORTAL_BASE_URL || "https://hybrid-ai-records.com").host;
  const key = process.env.INDEXNOW_API_KEY;
  const keyLocation = process.env.INDEXNOW_KEY_LOCATION;

  if (!key) {
    console.warn("[IndexNow] Skipping: INDEXNOW_API_KEY is not defined in environment.");
    return { ok: false, status: null, body: "" };
  }

  const payload = {
    host,
    key,
    keyLocation,
    urlList: urls,
  };

  console.log(`[IndexNow] Submitting ${urls.length} URL(s).`);
  for (const url of urls) {
    console.log(`[IndexNow] ${url}`);
  }

  try {
    const response = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });

    const status = response.status;
    const body = await response.text();
    console.log(`[IndexNow] HTTP ${status}`);
    console.log(`[IndexNow] Body: ${body}`);
    if (status === 200 || status === 202) {
      console.log(`[IndexNow] Successfully pushed ${urls.length} URL(s) to search engine indexers.`);
      return { ok: true, status, body };
    }
    console.error(`[IndexNow] Submission returned status: ${status}`);
    return { ok: false, status, body };
  } catch (error) {
    console.error("[IndexNow] Network dispatch failed:", error);
    const body = error instanceof Error ? error.message : "Network dispatch failed";
    return { ok: false, status: null, body };
  }
}
