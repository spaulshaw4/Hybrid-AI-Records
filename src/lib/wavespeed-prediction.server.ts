import { WAVESPEED_API_ROOT } from "@/lib/ai-provider.server";

/**
 * Shared WaveSpeed prediction parsing (server only).
 *
 * Submit goes to `POST /api/v3/{model-path}` with the input fields as the JSON
 * body. Poll is `GET /api/v3/predictions/{id}/result`. The media URL is
 * `data.outputs[0]`. Submit uses the model path directly.
 */

const SUCCESS_STATUS = "completed";
const FAILURE_STATUSES = new Set(["failed", "cancelled", "canceled", "timeout", "deleted"]);

export function waveSpeedModelUrl(modelPath: string): string {
  return `${WAVESPEED_API_ROOT}/${modelPath}`;
}

export function waveSpeedResultUrl(id: string): string {
  return `${WAVESPEED_API_ROOT}/predictions/${encodeURIComponent(id)}/result`;
}

export function redactSecrets(text: string): string {
  const keys = [
    process.env.WAVESPEED_API_KEY,
    process.env.REPLICATE_API_TOKEN,
    process.env.REPLICATE_API_KEY,
  ];
  let out = text;
  for (const key of keys) {
    const trimmed = key?.trim();
    if (trimmed) out = out.split(trimmed).join("[REDACTED]");
  }
  return out;
}

/** Unwraps `{ data: record }` or returns the object itself. */
export function waveSpeedData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const body = payload as Record<string, unknown>;
  const data = body.data;
  if (data && typeof data === "object" && !Array.isArray(data))
    return data as Record<string, unknown>;
  return body;
}

export function waveSpeedOutputUrl(payload: unknown): string | null {
  const outputs = waveSpeedData(payload).outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) return null;
  const first = outputs[0];
  return typeof first === "string" && first.trim() ? first : null;
}

export function waveSpeedStatus(payload: unknown): string {
  const status = waveSpeedData(payload).status;
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

export function waveSpeedId(payload: unknown): string | null {
  const id = waveSpeedData(payload).id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function waveSpeedErrorText(payload: unknown): string | null {
  const data = waveSpeedData(payload);
  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  for (const candidate of [data.error, body.error, body.message, body.detail, data.message]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function isWaveSpeedSuccess(status: string): boolean {
  return status === SUCCESS_STATUS;
}

export function isWaveSpeedFailure(status: string): boolean {
  return FAILURE_STATUSES.has(status);
}
