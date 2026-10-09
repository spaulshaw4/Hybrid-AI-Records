import { AuthRequiredError } from "@/lib/too-lost/errors";
import { MockTooLostClient } from "@/lib/too-lost/mock";
import { TooLostClient } from "@/lib/too-lost/client";
import { authMode, staticAccessToken } from "@/lib/too-lost/oauth";

export type PortalClient = TooLostClient | MockTooLostClient;

export function tooLostOrgId(): string {
  return process.env.TOO_LOST_ORG_ID?.trim() ?? "";
}

export async function getTooLostClient(): Promise<PortalClient> {
  const mode = authMode();
  if (mode === "mock") return new MockTooLostClient();

  const token = staticAccessToken();
  if (!token) throw new AuthRequiredError();
  return new TooLostClient(token, tooLostOrgId());
}
