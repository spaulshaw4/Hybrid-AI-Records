import { createError, defineEventHandler, getHeader, setResponseHeader } from "h3";
import { streamStemUpload } from "@/lib/stem-upload.server";

export default defineEventHandler(async (event) => {
  const result = await streamStemUpload(event.node.req, (name) => getHeader(event, name) ?? null);
  if (result.status >= 400) {
    if (result.status === 429 && typeof result.payload.retryAfter === "number") {
      setResponseHeader(event, "Retry-After", String(result.payload.retryAfter));
    }
    throw createError({
      statusCode: result.status,
      statusMessage: String(result.payload.error || "Upload failed"),
      data: result.payload,
    });
  }
  return result.payload;
});
