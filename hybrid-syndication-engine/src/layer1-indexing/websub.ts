export async function notifyWebSubHub(feedUrl: string): Promise<boolean> {
  const hubUrl = process.env.WEBSUB_HUB_URL || "https://pubsubhubbub.appspot.com/";

  const formData = new URLSearchParams();
  formData.append("hub.mode", "publish");
  formData.append("hub.url", feedUrl);

  try {
    const response = await fetch(hubUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    if (response.status === 204 || response.status === 200) {
      console.log(`[WebSub] Hub notified for feed: ${feedUrl}`);
      return true;
    } else {
      console.warn(`[WebSub] Hub returned status: ${response.status}`);
      return false;
    }
  } catch (error) {
    console.error("[WebSub] Failed to broadcast to hub:", error);
    return false;
  }
}
