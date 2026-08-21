import { useCallback, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, KeyRound, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { validateReplicateKey, type ReplicateKeyCheck as KeyCheck } from "@/lib/replicate-validate.functions";

/** Dev-facing token validation: verifies the engine key against the provider account endpoint. */
export function ReplicateKeyCheck() {
  const run = useServerFn(validateReplicateKey);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeyCheck | null>(null);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      setResult(await run({ data: undefined }));
    } catch {
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [run]);

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Engine key validation — checks the configured token against the provider account endpoint.
        </p>
        <Button variant="outline" size="sm" className="gap-2 text-xs" disabled={busy} onClick={() => void check()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <KeyRound className="size-3.5" aria-hidden />}
          Validate key
        </Button>
      </div>
      {result ? (
        <ul className="mt-2 space-y-1 text-xs">
          <li className="flex items-center gap-2">
            {result.valid ? (
              <CheckCircle2 className="size-3.5 text-primary" aria-hidden />
            ) : (
              <XCircle className="size-3.5 text-destructive" aria-hidden />
            )}
            <span className={result.valid ? "text-foreground" : "text-destructive"}>{result.message}</span>
          </li>
          <li className="font-mono text-muted-foreground">
            token shape: {result.configured ? `${result.keyPrefix} · ${result.keyLength} chars` : "missing"} ·{" "}
            {result.looksLikeR8 ? "raw r8_ token" : "NOT an r8_ token"}
          </li>
          <li className="font-mono text-muted-foreground">
            {result.endpoint} → {result.status ?? "no response"}
          </li>
          {!result.valid && (
            <li className="text-muted-foreground">
              {result.configured
                ? "Fix: issue a fresh raw provider token and save it through the secure form — the pipeline reads one key only."
                : "Fix: no engine key is configured. Save a raw provider token through the secure form before running a render."}
            </li>
          )}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Not verified yet — run this before any paid render so a bad credential fails here instead
          of mid-queue.
        </p>
      )}
    </div>
  );
}
