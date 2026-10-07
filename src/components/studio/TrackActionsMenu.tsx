import { useEffect, useRef, useState } from "react";
import { FileAudio, MoreVertical, Music, Trash2 } from "lucide-react";

type TrackActionsMenuProps = {
  trackId: string;
  title: string;
  mp3Url: string | null;
  wavUrl: string | null;
  onDelete: (id: string) => void;
};

function safeFileName(title: string, extension: string): string {
  const base = title
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return `${base || "master"}.${extension}`;
}

function isCrossOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin !== window.location.origin;
  } catch {
    return true;
  }
}

async function saveDownload(url: string, filename: string): Promise<void> {
  if (!isCrossOrigin(url)) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error("Download failed");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export function TrackActionsMenu({ trackId, title, mp3Url, wavUrl, onDelete }: TrackActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const download = (url: string | null, extension: string) => {
    if (!url) return;
    setOpen(false);
    void saveDownload(url, safeFileName(title, extension)).catch(() => undefined);
  };

  const itemStyle = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    textAlign: "left" as const,
    background: "transparent",
    border: "none",
    color: "#f8fafc",
    fontSize: 13,
    padding: "8px 10px",
    cursor: "pointer",
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label={`Actions for ${title}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          background: "transparent",
          border: "1px solid #3f3f46",
          color: "#f4f4f5",
          borderRadius: 8,
          width: 32,
          height: 32,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
      >
        <MoreVertical size={16} />
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: 36,
            zIndex: 20,
            minWidth: 220,
            background: "#18181b",
            border: "1px solid #3f3f46",
            borderRadius: 10,
            padding: 4,
            boxShadow: "0 16px 32px rgba(0,0,0,0.45)",
          }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!mp3Url}
            onClick={() => download(mp3Url, "mp3")}
            style={{ ...itemStyle, opacity: mp3Url ? 1 : 0.4, cursor: mp3Url ? "pointer" : "not-allowed" }}
          >
            <Music size={14} color="#f87171" />
            Download MP3 (320 kbps)
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!wavUrl}
            onClick={() => download(wavUrl, "wav")}
            style={{ ...itemStyle, opacity: wavUrl ? 1 : 0.4, cursor: wavUrl ? "pointer" : "not-allowed" }}
          >
            <FileAudio size={14} color="#f87171" />
            Download Master WAV
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete(trackId);
            }}
            style={{ ...itemStyle, color: "#fda4af" }}
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
