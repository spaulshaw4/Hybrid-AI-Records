/**
 * Browser-safe Supabase URL + anon/publishable key lookup.
 * Never reads the service role key.
 */
function trim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const next = value.trim();
  return next || undefined;
}

function fromVite(name: string): string | undefined {
  try {
    return trim((import.meta.env as Record<string, unknown>)[name]);
  } catch {
    return undefined;
  }
}

function fromProcess(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return trim(process.env[name]);
}

function first(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = fromVite(name) ?? fromProcess(name);
    if (value) return value;
  }
  return undefined;
}

export function supabaseUrl(): string | undefined {
  return first(["NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_URL"]);
}

export function supabaseAnonKey(): string | undefined {
  return first([
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
  ]);
}
