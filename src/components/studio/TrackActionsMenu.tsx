import { ArrowLeftRight, Download, MoreVertical, Music2, Trash2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type TrackActionsMenuProps = {
  title: string;
  mp3Url: string | null;
  referenceUrl: string | null;
  onUseAsReference: () => void;
  onTrackInjection: () => void;
  onDelete: () => void;
};

function masterFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const name = base || "master";
  return name.toLowerCase().endsWith(".mp3") ? name : `${name}.mp3`;
}

function httpsUrl(value: string | null): string | null {
  const text = value?.trim() ?? "";
  if (!text || !/^https:\/\//i.test(text)) return null;
  return text;
}

async function saveDownload(url: string, filename: string): Promise<void> {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error("Download failed");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export function TrackActionsMenu({
  title,
  mp3Url,
  referenceUrl,
  onUseAsReference,
  onTrackInjection,
  onDelete,
}: TrackActionsMenuProps) {
  const downloadUrl = httpsUrl(mp3Url);
  const bedUrl = httpsUrl(referenceUrl);

  const downloadMaster = () => {
    if (!downloadUrl) return;
    void saveDownload(downloadUrl, masterFileName(title)).catch(() => undefined);
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Track actions"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-transparent text-zinc-100"
        >
          <MoreVertical className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-20 min-w-[220px] border-white/10 bg-zinc-900 text-zinc-100">
        <DropdownMenuItem disabled={!bedUrl} onSelect={() => onUseAsReference()}>
          <Music2 aria-hidden="true" />
          Use as Reference Track
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!bedUrl} onSelect={() => onTrackInjection()}>
          <ArrowLeftRight aria-hidden="true" />
          Track Injection (Swap)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!downloadUrl} onSelect={downloadMaster}>
          <Download aria-hidden="true" />
          Download Master
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-rose-300 focus:bg-rose-950 focus:text-rose-200"
          onSelect={() => onDelete()}
        >
          <Trash2 aria-hidden="true" />
          Delete from Vault
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
