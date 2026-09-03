import { createError, defineEventHandler, getHeader, readBody, setResponseHeader } from "h3";
import { handleSignedUrlPost } from "@/lib/storage-signed-url.server";

export default defineEventHandler(async (event) => {
  const userId = getHeader(event, "x-user-id");
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized playback request" });
  }
  const body = await readBody(event);
  const request = new Request("http://localhost/api/storage/signed-url", {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": userId },
    body: JSON.stringify(body ?? {}),
  });
  const response = await handleSignedUrlPost(request);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: "Sign failed" }))) as {
      error?: string;
      retryAfter?: number;
    };
    const retryAfter = payload.retryAfter ?? Number(response.headers.get("Retry-After") || 0);
    if (response.status === 429 && retryAfter > 0) {
      setResponseHeader(event, "Retry-After", String(retryAfter));
    }
    throw createError({
      statusCode: response.status,
      statusMessage: payload.error || "Failed generating signed playback URL",
      data: payload,
    });
  }
  return await response.json();
});
