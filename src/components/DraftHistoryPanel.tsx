import { useCallback, useEffect, useState } from "react";
import { History, RotateCcw, Trash2, X } from "lucide-react";
import {
  clearHistory,
  deleteSnapshot,
  describeChange,
  listSnapshots,
  MAX_SNAPSHOTS,
  type DraftSnapshot,
} from "@/lib/draft-history";

const formatStamp = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const preview = (s: DraftSnapshot) => {
  const bits = [s.artist.trim(), s.notes.trim().slice(0, 60)].filter(Boolean);
  return bits.length ? bits.join(" — ") : "Empty version";
};

type Props = {
  scope: string;
  /** Bumped by the parent after each autosave so the list refreshes. */
  refreshKey: number;
  onRestore: (snapshot: DraftSnapshot) => void;
};

/**
 * Version history for the current draft slot. Lets an artist roll back to any
 * earlier autosaved snapshot after making changes they regret.
 */
export function DraftHistoryPanel({ scope, refreshKey, onRestore }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DraftSnapshot[]>([]);
  const [status, setStatus] = useState("");

  const reload = useCallback(() => {
    void listSnapshots(scope).then(setItems);
  }, [scope]);

  useEffect(() => {
    reload();
  }, [reload, refreshKey]);

  if (items.length === 0) return null;

  return (
    <div className="border border-border bg-surface/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-start"
      >
        <span className="flex items-center gap-2">
          <History className="size-4 text-[#4b8bff]" aria-hidden="true" />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground">
            Version history
          </span>
          <span className="text-xs text-muted-foreground">
            {items.length} saved version{items.length === 1 ? "" : "s"}
          </span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {open ? "Hide" : "Show"}
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Restore any earlier snapshot of this application. History stays encrypted on this
            device and keeps the last {MAX_SNAPSHOTS} versions.
          </p>

          <ul className="mt-3 space-y-2">
            {items.map((snap, i) => (
              <li
                key={snap.id}
                className="flex flex-col gap-2 border border-border/70 bg-background/40 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-foreground">
                    {formatStamp(snap.at)}
                    {i === 0 && <span className="ms-2 text-[#7ee0a1]">Current</span>}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{preview(snap)}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                    {describeChange(snap, items[i + 1])}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onRestore(snap);
                      setStatus(`Restored the version from ${formatStamp(snap.at)}.`);
                    }}
                    className="inline-flex items-center gap-1.5 border border-[#4b8bff] px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[#bcd4ff] transition-colors hover:bg-[#4b8bff] hover:text-black"
                  >
                    <RotateCcw className="size-3.5" aria-hidden="true" />
                    Restore
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete the version from ${formatStamp(snap.at)}`}
                    onClick={() => {
                      void deleteSnapshot(scope, snap.id).then((next) => {
                        setItems(next);
                        setStatus("Version deleted.");
                      });
                    }}
                    className="inline-flex items-center justify-center border border-border p-2 text-muted-foreground transition-colors hover:border-[#e11d2e] hover:text-[#e11d2e]"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => {
              clearHistory(scope);
              setItems([]);
              setStatus("Version history cleared.");
            }}
            className="mt-3 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-[#e11d2e]"
          >
            <X className="size-3.5" aria-hidden="true" />
            Clear history
          </button>

          <p className="sr-only" role="status" aria-live="polite">
            {status}
          </p>
        </div>
      )}
    </div>
  );
}

export default DraftHistoryPanel;
