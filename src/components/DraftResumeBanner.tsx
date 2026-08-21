import { useCallback, useEffect, useState } from "react";
import { Archive, Cloud, CloudOff, RotateCcw, Trash2 } from "lucide-react";
import {
  listDrafts,
  removeDraft,
  type SavedDraftEntry,
} from "@/lib/application-drafts";
import {
  currentUserId,
  deleteAccountDraft,
  isCloudSyncEnabled,
  mergeAccountDraftsIntoDevice,
  pushDeviceDraftsToAccount,
  setCloudSyncEnabled,
} from "@/lib/account-drafts";
import {
  describeSweep,
  listArchivedDrafts,
  readRetention,
  removeArchivedDraft,
  restoreArchivedDraft,
  retentionLabel,
  sweepExpiredDrafts,
  writeRetention,
  RETENTION_CHOICES,
  type ArchivedDraftEntry,
  type RetentionPolicy,
  DEFAULT_RETENTION,
} from "@/lib/draft-retention";


const relative = (ts: number) => {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return new Date(ts).toLocaleDateString();
};

type Props = {
  /** Only show drafts for this package slug. */
  slug: string;
  /** Currently open scope — its draft is already loaded in the form. */
  activeScope: string;
  /** Called when the artist chooses to reopen another saved draft. */
  onResume: (entry: SavedDraftEntry) => void;
};

export function DraftResumeBanner({ slug, activeScope, onResume }: Props) {
  const [entries, setEntries] = useState<SavedDraftEntry[]>([]);
  const [tick, setTick] = useState(0);
  const [signedIn, setSignedIn] = useState(false);
  const [cloudOn, setCloudOn] = useState(false);
  const [cloudStatus, setCloudStatus] = useState("");

  const [retention, setRetention] = useState<RetentionPolicy>(DEFAULT_RETENTION);
  const [archived, setArchived] = useState<ArchivedDraftEntry[]>([]);
  const [sweepNote, setSweepNote] = useState("");

  useEffect(() => {
    setCloudOn(isCloudSyncEnabled());
    setRetention(readRetention());
    void currentUserId().then((id) => setSignedIn(Boolean(id)));
  }, []);

  // Apply the expiration policy, then list whatever is archived on this device.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await sweepExpiredDrafts(retention, [activeScope]);
      if (cancelled) return;
      const note = describeSweep(result);
      if (note) setSweepNote(note);
      setArchived(await listArchivedDrafts().then((a) => a.filter((e) => e.slug === slug)));
      if (result.scopes.length > 0) setTick((t) => t + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [retention, activeScope, slug, tick]);

  const updateRetention = useCallback((next: RetentionPolicy) => {
    writeRetention(next);
    setRetention(next);
    setSweepNote("");
  }, []);



  // When sync is on and the artist is signed in, pull their account drafts
  // onto this device before listing what's resumable here.
  useEffect(() => {
    if (!signedIn || !cloudOn) return;
    let cancelled = false;
    void mergeAccountDraftsIntoDevice().then((restored) => {
      if (cancelled) return;
      if (restored > 0) {
        setCloudStatus(`${restored} draft${restored === 1 ? "" : "s"} restored from your account.`);
        setTick((t) => t + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn, cloudOn]);

  const toggleCloud = useCallback(async () => {
    const next = !cloudOn;
    setCloudSyncEnabled(next);
    setCloudOn(next);
    if (!next) {
      setCloudStatus("Cloud sync off — drafts stay on this device only.");
      return;
    }
    if (!signedIn) {
      setCloudStatus("Sign in to finish turning on cloud sync for your drafts.");
      return;
    }
    setCloudStatus("Syncing your drafts…");
    const pushed = await pushDeviceDraftsToAccount(await listDrafts());
    const restored = await mergeAccountDraftsIntoDevice();
    setTick((t) => t + 1);
    setCloudStatus(
      `Cloud sync on — ${pushed} draft${pushed === 1 ? "" : "s"} saved to your account${
        restored > 0 ? `, ${restored} restored from another device` : ""
      }.`,
    );
  }, [cloudOn, signedIn]);

  useEffect(() => {
    let cancelled = false;
    void listDrafts().then((all) => {
      if (!cancelled) setEntries(all.filter((e) => e.slug === slug));
    });
    return () => {
      cancelled = true;
    };
  }, [slug, tick, activeScope]);


  // Keep the list honest while the form autosaves in the background.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 15000);
    return () => window.clearInterval(id);
  }, []);

  if (entries.length === 0 && archived.length === 0 && !signedIn) return null;


  return (
    <div className="mb-6 border border-border-strong bg-background/30 p-5 backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <RotateCcw size={14} className="text-[#e11d2e]" />
          <h2 className="text-xs font-semibold uppercase tracking-widest text-white">
            {cloudOn && signedIn ? "Saved applications (synced)" : "Saved applications on this device"}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => void toggleCloud()}
          aria-pressed={cloudOn}
          className={`flex min-h-11 items-center gap-2 border px-3 py-2 text-[11px] font-semibold uppercase tracking-widest transition-colors ${
            cloudOn
              ? "border-[#4b8bff] text-[#4b8bff] hover:bg-[#4b8bff] hover:text-black"
              : "border-border text-muted-foreground hover:border-[#4b8bff] hover:text-[#4b8bff]"
          }`}
        >
          {cloudOn ? <Cloud size={13} /> : <CloudOff size={13} />}
          {cloudOn ? "Cloud sync on" : "Cloud sync off"}
        </button>
      </div>
      {(cloudStatus || (cloudOn && !signedIn)) && (
        <p aria-live="polite" className="mt-2 text-xs text-[#4b8bff]">
          {cloudStatus || "Sign in to sync these drafts to your account."}
        </p>
      )}

      <ul className="mt-4 space-y-2">
        {entries.map((entry) => {
          const isActive = entry.scope === activeScope;
          const label = entry.mode === "bundle" ? "10-track bundle" : "Single track";
          return (
            <li
              key={entry.scope}
              className="flex flex-wrap items-center justify-between gap-3 border border-border/60 bg-background/40 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">
                  {label}
                  {isActive && (
                    <span className="ms-2 text-[11px] font-semibold uppercase tracking-wider text-[#4b8bff]">
                      open now
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {entry.draft.artist || entry.draft.email || "Unnamed draft"} · autosaved{" "}
                  {relative(entry.draft.savedAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {!isActive && (
                  <button
                    type="button"
                    onClick={() => onResume(entry)}
                    className="border border-[#4b8bff] px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-[#4b8bff] transition-colors hover:bg-[#4b8bff] hover:text-black"
                  >
                    Resume
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    removeDraft(entry.scope);
                    if (cloudOn && signedIn) void deleteAccountDraft(entry.scope);
                    setTick((t) => t + 1);
                  }}

                  className="border border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:border-[#e11d2e] hover:text-[#e11d2e]"
                  aria-label={`Delete saved ${label.toLowerCase()} draft`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {archived.length > 0 && (
        <div className="mt-5 border-t border-border/60 pt-4">
          <div className="flex items-center gap-2">
            <Archive size={13} className="text-muted-foreground" />
            <h3 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Archived applications
            </h3>
          </div>
          <ul className="mt-3 space-y-2">
            {archived.map((entry) => (
              <li
                key={entry.scope}
                className="flex flex-wrap items-center justify-between gap-3 border border-border/40 bg-background/20 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-white">
                    {entry.mode === "bundle" ? "10-track bundle" : "Single track"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {entry.draft.artist || entry.draft.email || "Unnamed draft"} · archived{" "}
                    {relative(entry.archivedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void restoreArchivedDraft(entry).then(() => setTick((t) => t + 1));
                    }}
                    className="border border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:border-[#4b8bff] hover:text-[#4b8bff]"
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removeArchivedDraft(entry.scope);
                      setTick((t) => t + 1);
                    }}
                    className="border border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:border-[#e11d2e] hover:text-[#e11d2e]"
                    aria-label="Delete archived draft"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
        <label
          htmlFor="draft-retention-days"
          className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Expire old drafts
        </label>
        <select
          id="draft-retention-days"
          value={retention.days}
          onChange={(e) => updateRetention({ ...retention, days: Number(e.target.value) })}
          className="min-h-11 border border-border bg-background/60 px-3 py-2 text-xs text-white"
        >
          {RETENTION_CHOICES.map((d) => (
            <option key={d} value={d}>
              {retentionLabel(d)}
            </option>
          ))}
        </select>
        <select
          aria-label="What happens to expired drafts"
          value={retention.action}
          onChange={(e) =>
            updateRetention({ ...retention, action: e.target.value === "delete" ? "delete" : "archive" })
          }
          disabled={retention.days === 0}
          className="min-h-11 border border-border bg-background/60 px-3 py-2 text-xs text-white disabled:opacity-50"
        >
          <option value="archive">Archive them</option>
          <option value="delete">Delete them</option>
        </select>
      </div>
      {sweepNote && (
        <p aria-live="polite" className="mt-2 text-xs text-[#e11d2e]">
          {sweepNote}
        </p>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Answers autosave as you type. Attached files aren&apos;t saved and must be re-attached.
        {retention.days > 0
          ? ` Drafts untouched for ${retention.days} days are ${
              retention.action === "archive" ? "archived" : "deleted"
            } automatically.`
          : " Drafts are kept until you delete them."}
      </p>

    </div>
  );
}
