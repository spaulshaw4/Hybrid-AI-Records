import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { toast } from "sonner";

import { sendVaultTrackToEmail } from "@/lib/vault-client";
import { cn } from "@/lib/utils";

const COOLDOWN_MS = 30_000;

type Lock = { until: number; sent: boolean };

const locks = new Map<string, number>();
const sentTracks = new Set<string>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function cooling(trackId: string): boolean {
  const until = locks.get(trackId) ?? 0;
  if (until <= Date.now()) {
    if (until) {
      locks.delete(trackId);
      sentTracks.delete(trackId);
    }
    return false;
  }
  return true;
}

function armCooldown(trackId: string) {
  locks.set(trackId, Date.now() + COOLDOWN_MS);
  emit();
}

const BUTTON_CLASS =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-zinc-700 bg-transparent px-2 text-[11px] font-medium text-zinc-100 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60";

export function SendVaultTrackEmailButton({
  trackId,
  className,
}: {
  trackId: string;
  className?: string;
}) {
  const [clock, setClock] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = trackId.trim();
  const locked = id ? cooling(id) : false;
  const sent = id ? sentTracks.has(id) && locked : false;
  const disabled = !id || sending || locked || inflight.has(id);
  const label = sending ? "Sending..." : sent ? "Sent to your email!" : "Send to Email";

  useEffect(() => {
    const update = () => setClock((value) => value + 1);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);

  useEffect(() => {
    if (!id) return;
    const until = locks.get(id) ?? 0;
    if (until <= Date.now()) return;
    const timer = window.setTimeout(() => emit(), Math.max(0, until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [id, clock]);

  const send = async () => {
    if (!id || sending || cooling(id) || inflight.has(id)) return;
    inflight.add(id);
    armCooldown(id);
    setSending(true);
    setError(null);
    try {
      const result = await sendVaultTrackToEmail(id);
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      sentTracks.add(id);
      emit();
      toast.success("Sent to your email!");
    } catch {
      const message = "Email could not be sent.";
      setError(message);
      toast.error(message);
    } finally {
      inflight.delete(id);
      setSending(false);
      emit();
    }
  };

  return (
    <>
      <button
        type="button"
        className={cn(BUTTON_CLASS, className)}
        disabled={disabled}
        aria-label={label}
        title={error ?? label}
        onClick={(event) => {
          event.stopPropagation();
          void send();
        }}
      >
        <Mail className="size-3.5 shrink-0" aria-hidden />
        <span>{label}</span>
      </button>
      {error ? (
        <span
          className="max-w-[12rem] truncate text-[10px] text-rose-300"
          title={error}
          onClick={(event) => event.stopPropagation()}
        >
          {error}
        </span>
      ) : null}
    </>
  );
}
