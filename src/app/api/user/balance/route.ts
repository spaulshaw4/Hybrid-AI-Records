import { resolveStudioSession } from "@/lib/studio-request-auth.server";

function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : "";
  return name === "UnauthorizedSessionError" || status === 401 || message === "Unauthorized session";
}

export async function GET(req: Request): Promise<Response> {
  try {
    const requestedUserId = new URL(req.url).searchParams.get("userId")?.trim() ?? "";
    if (requestedUserId === "guest_user") {
      return Response.json({ balance: 0 });
    }

    let userId = "";
    let supabase: Awaited<ReturnType<typeof resolveStudioSession>>["supabase"] | null = null;
    try {
      const session = await resolveStudioSession(req);
      userId = session.userId.trim();
      supabase = session.supabase;
    } catch (err) {
      if (isUnauthorized(err)) {
        return Response.json({ balance: 0 });
      }
      throw err;
    }

    if (!userId || userId === "guest_user" || !supabase) {
      return Response.json({ balance: 0 });
    }
    if (requestedUserId && requestedUserId !== userId) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data, error } = await supabase
      .from("token_balances")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ balance: data?.balance ?? 0 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load token balance";
    return Response.json({ error: message }, { status: 500 });
  }
}
