import { TooLostError, rateLimitMessage } from "@/lib/too-lost/errors";
import type {
  DeliveryWrite,
  DraftReleaseInput,
  Release,
  ReleaseList,
  SubmitWrite,
  TrackWrite,
  UploadTarget,
} from "@/lib/too-lost/types";

type ValidateBody = {
  valid?: boolean;
  message?: string;
  data?: { valid?: boolean; message?: string };
};

function trimEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function apiBaseUrl(): string {
  const raw = trimEnv("TOOLOST_API_URL") || trimEnv("TOO_LOST_API_URL") || "https://api-sandbox.toolost.com/v1";
  return raw.replace(/\/$/, "");
}

function validationMessage(body: ValidateBody, fallback: string): string | null {
  if (body.valid === false) return body.message || fallback;
  if (body.data?.valid === false) return body.data.message || body.message || fallback;
  return null;
}

export class TooLostClient {
  constructor(
    private readonly accessToken: string,
    private readonly orgId = "",
  ) {}

  private async request<T>(endpoint: string, options: RequestInit = {}, allowRetry = true): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    const orgId = this.orgId.trim() || trimEnv("TOO_LOST_ORG_ID");
    if (orgId) headers.set("X-Organization-Id", orgId);
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(`${apiBaseUrl()}${endpoint}`, {
      ...options,
      headers,
      cache: "no-store",
    });

    if (res.status === 429) {
      const method = (options.method || "GET").toUpperCase();
      const delay = retryDelayMs(res.headers);
      await res.body?.cancel().catch(() => undefined);
      if (allowRetry && method === "GET" && delay !== null) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.request<T>(endpoint, options, false);
      }
      throw new TooLostError(rateLimitMessage(res.headers), 429, res.headers);
    }

    const text = await res.text();
    const body = text ? parseJson(text) : {};

    if (!res.ok) {
      const message =
        (body && typeof body === "object" && "message" in body && typeof body.message === "string"
          ? body.message
          : "") || `API Error ${res.status}`;
      throw new TooLostError(message, res.status, res.headers);
    }

    return body as T;
  }

  async listReleases(status?: string, page = 1, perPage = 20): Promise<ReleaseList> {
    const params = new URLSearchParams({
      page: String(page),
      perPage: String(perPage),
    });
    if (status) params.set("status", status);
    return this.request<ReleaseList>(`/releases?${params}`);
  }

  async getRelease(releaseId: number): Promise<{ data: Release }> {
    return this.request<{ data: Release }>(`/releases/${releaseId}`);
  }

  async createDraftRelease(payload: DraftReleaseInput): Promise<{ data: Release }> {
    return this.request<{ data: Release }>("/releases", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async validateUpc(upc: string): Promise<void> {
    const body = await this.request<ValidateBody>("/releases/validate/upc", {
      method: "POST",
      body: JSON.stringify({ upc }),
    });
    const message = validationMessage(body, "UPC is not valid.");
    if (message) throw new TooLostError(message, 422);
  }

  async validateIsrc(isrc: string): Promise<void> {
    const body = await this.request<ValidateBody>("/releases/validate/isrc", {
      method: "POST",
      body: JSON.stringify({ isrc }),
    });
    const message = validationMessage(body, "ISRC is not valid.");
    if (message) throw new TooLostError(message, 422);
  }

  async getArtworkUploadUrl(
    releaseId: number,
    fileName: string,
    contentType: "image/jpeg" | "image/png",
  ): Promise<{ data: UploadTarget }> {
    return this.request<{ data: UploadTarget }>(`/releases/${releaseId}/artwork/upload-url`, {
      method: "POST",
      body: JSON.stringify({ fileName, contentType }),
    });
  }

  async getTrackUploadUrl(
    releaseId: number,
    fileName: string,
    contentType: string,
    kind: "audio",
  ): Promise<{ data: UploadTarget }> {
    return this.request<{ data: UploadTarget }>(`/releases/${releaseId}/tracks/upload-url`, {
      method: "POST",
      body: JSON.stringify({ fileName, contentType, kind }),
    });
  }

  async updateMetadata(
    releaseId: number,
    metadata: Record<string, unknown>,
  ): Promise<{ data: Release }> {
    if (metadata.coverFileKey && metadata.coverUrl) {
      throw new TooLostError("Send coverFileKey or coverUrl, never both.", 422);
    }
    return this.request<{ data: Release }>(`/releases/${releaseId}/metadata`, {
      method: "PATCH",
      body: JSON.stringify(metadata),
    });
  }

  async setTracklist(releaseId: number, tracks: TrackWrite[]): Promise<{ data: Release }> {
    return this.request<{ data: Release }>(`/releases/${releaseId}/tracks`, {
      method: "PUT",
      body: JSON.stringify({ tracks }),
    });
  }

  async updateDelivery(releaseId: number, delivery: DeliveryWrite): Promise<{ data: Release }> {
    return this.request<{ data: Release }>(`/releases/${releaseId}/delivery`, {
      method: "PATCH",
      body: JSON.stringify({ delivery }),
    });
  }

  async submitRelease(
    releaseId: number,
    payload: SubmitWrite,
  ): Promise<{ data: Release; message: string }> {
    return this.request<{ data: Release; message: string }>(`/releases/${releaseId}/submit`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
}

function parseJson(text: string): { message?: string } | Record<string, unknown> {
  try {
    return JSON.parse(text) as { message?: string };
  } catch {
    return { message: text.slice(0, 180) };
  }
}

function retryDelayMs(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (!raw) return 1000;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(raw) - Date.now());
  if (!Number.isFinite(delay) || delay > 5000) return null;
  return delay;
}
