import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  defineEventHandler,
  getRequestHeader,
  setResponseHeaders,
  setResponseStatus,
  sendStream,
} from "h3";
import { cacheHeadersForPath } from "../../src/lib/cache-headers.server";

const ROOTS = [path.resolve("D:/MusicDatasets/releases"), path.resolve("D:/MusicDatasets/scratch")];

const MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
};

function safeAudioPath(urlPath: string): string | null {
  const rel = urlPath.replace(/^\/stream\//, "").replace(/^\/+/, "");
  if (!rel || rel.includes("..") || rel.includes("\0")) return null;
  if (!/\.(wav|flac|m4a|mp3|aac)$/i.test(rel)) return null;
  for (const root of ROOTS) {
    const resolved = path.resolve(root, rel);
    if (resolved.startsWith(root + path.sep) && existsSync(resolved)) return resolved;
  }
  return null;
}

function streamCacheHeaders(urlPath: string, audioPath: string): Record<string, string> {
  const [pathname, search = ""] = urlPath.split("?");
  const normalized = audioPath.replace(/\\/g, "/").toLowerCase();
  const cachePath = normalized.includes("/scratch/") ? "/stream/session_/" : pathname || "/stream/";
  return cacheHeadersForPath(cachePath, search ? `?${search}` : "");
}

export default defineEventHandler(async (event) => {
  const url = event.node.req.url || "";
  if (!url.startsWith("/stream/")) return;

  const audioPath = safeAudioPath(url.split("?")[0] ?? "");
  if (!audioPath) {
    setResponseStatus(event, 404);
    setResponseHeaders(event, { "cache-control": "no-store" });
    return { error: "Audio deliverable not found" };
  }

  const stat = statSync(audioPath);
  const fileSize = stat.size;
  const range = getRequestHeader(event, "range");
  const contentType = MIME[path.extname(audioPath).toLowerCase()] || "audio/wav";

  if (range) {
    const parts = range.replace(/bytes=/i, "").split("-");
    const start = Number.parseInt(parts[0] || "0", 10);
    const end = parts[1] ? Number.parseInt(parts[1], 10) : fileSize - 1;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end >= fileSize ||
      start > end
    ) {
      setResponseStatus(event, 416);
      setResponseHeaders(event, { "Content-Range": `bytes */${fileSize}` });
      return;
    }
    const chunkSize = end - start + 1;
    setResponseStatus(event, 206);
    setResponseHeaders(event, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(chunkSize),
      "Content-Type": contentType,
      ...streamCacheHeaders(url, audioPath),
    });
    return sendStream(event, createReadStream(audioPath, { start, end }));
  }

  setResponseHeaders(event, {
    "Content-Length": String(fileSize),
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    ...streamCacheHeaders(url, audioPath),
  });
  return sendStream(event, createReadStream(audioPath));
});
