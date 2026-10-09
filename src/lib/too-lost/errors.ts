export class TooLostError extends Error {
  readonly status: number;
  readonly quotaRemaining: string | null;
  readonly rateLimitRemaining: string | null;
  readonly retryAfter: string | null;

  constructor(message: string, status: number, headers?: Headers) {
    super(message);
    this.name = "TooLostError";
    this.status = status;
    this.quotaRemaining = headers?.get("X-Api-Quota-Remaining") ?? null;
    this.rateLimitRemaining = headers?.get("X-RateLimit-Remaining") ?? null;
    this.retryAfter = headers?.get("Retry-After") ?? null;
  }
}

export class AuthRequiredError extends Error {
  constructor() {
    super("Connect Too Lost to continue.");
    this.name = "AuthRequiredError";
  }
}

export function rateLimitMessage(headers: Headers): string {
  const retryAfter = headers.get("Retry-After") || "60";
  const quotaRemaining = headers.get("X-Api-Quota-Remaining");
  return `Rate limit exceeded. Retry after ${retryAfter} seconds. (Quota remaining: ${quotaRemaining})`;
}
