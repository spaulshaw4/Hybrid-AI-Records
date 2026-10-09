import { Download, MoreVertical, Trash2 } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type TrackActionsMenuProps = {
  title: string;
  mp3Url: string | null | undefined;
  wavUrl: string | null | undefined;
  onDelete: () => void;
};

const WAV_UNAVAILABLE = "WAV master is currently processing or unavailable for this take.";

function cleanTitle(title: string): string {
  const cleaned = title.replace(/[^A-Za-z0-9_-]/g, "_");
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "Master_Track";
}

function httpsUrl(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!text || !/^https:\/\//i.test(text)) return null;
  return text;
}

function withDownload(raw: string | null | undefined, filename: string): string | null {
  if (!raw) return null;
  const param = `download=${encodeURIComponent(filename)}`;
  const hashAt = raw.indexOf("#");
  const hash = hashAt >= 0 ? raw.slice(hashAt) : "";
  const withoutHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const joiner = withoutHash.includes("?") ? "&" : "?";
  return `${withoutHash}${joiner}${param}${hash}`;
}

function openDownload(href: string) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function TrackActionsMenu({ title, mp3Url, wavUrl, onDelete }: TrackActionsMenuProps) {
  const mp3 = httpsUrl(mp3Url);
  const wav = httpsUrl(wavUrl);
  const mp3Source = mp3 ?? wav;
  const distinctWav = wav && wav !== mp3 ? wav : null;
  const fileBase = cleanTitle(title);

  const downloadMp3 = () => {
    if (!mp3Source) return;
    const href = withDownload(mp3Source, `${fileBase}.mp3`);
    if (!href) return;
    openDownload(href);
  };

  const downloadWav = () => {
    if (!distinctWav) {
      window.alert(WAV_UNAVAILABLE);
      return;
    }
    const href = withDownload(distinctWav, `${fileBase}.wav`);
    if (!href) return;
    openDownload(href);
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Track options"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-transparent text-zinc-100"
        >
          <MoreVertical className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-20 min-w-[220px] border-white/10 bg-zinc-900 text-zinc-100">
        <DropdownMenuItem disabled={!mp3Source} onSelect={downloadMp3}>
          <Download aria-hidden="true" />
          Download MP3
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={downloadWav}>
          <Download aria-hidden="true" />
          Download WAV
        </DropdownMenuItem>
        <DropdownMenuItem className="text-rose-300 focus:bg-rose-950 focus:text-rose-200" onSelect={() => onDelete()}>
          <Trash2 aria-hidden="true" />
          Delete from Vault
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
