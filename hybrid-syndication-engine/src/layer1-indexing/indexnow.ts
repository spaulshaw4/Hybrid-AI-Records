export async function submitToIndexNow(urls: string[]): Promise<boolean> {
  const host = new URL(process.env.PORTAL_BASE_URL || "https://hybrid-ai-records.com").host;
  const key = process.env.INDEXNOW_API_KEY;
  const keyLocation = process.env.INDEXNOW_KEY_LOCATION;

  if (!key) {
    console.warn("[IndexNow] Skipping: INDEXNOW_API_KEY is not defined in environment.");
    return false;
  }

  const payload = {
    host,
    key,
    keyLocation,
    urlList: urls,
  };

  try {
    const response = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });

    const status = response.status;
    if (status === 200 || status === 202) {
      console.log(`[IndexNow] Successfully pushed ${urls.length} URL(s) to search engine indexers.`);
      return true;
    } else {
      console.error(`[IndexNow] Submission returned status: ${status}`);
      return false;
    }
  } catch (error) {
    console.error("[IndexNow] Network dispatch failed:", error);
    return false;
  }
}
