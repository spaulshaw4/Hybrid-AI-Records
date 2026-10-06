import { useState, type FormEvent } from "react";

type ReferenceSelection = { id: string; name: string };

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onReferenceSelected: (reference: ReferenceSelection) => void;
};

export function ReferenceModal({ isOpen, onClose, onReferenceSelected }: Props) {
  const [tab, setTab] = useState<"upload" | "library">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  if (!isOpen) return null;

  async function handleUpload(event: FormEvent) {
    event.preventDefault();
    if (!file || isUploading) return;
    setError("");
    setIsUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/reference", { method: "POST", body });
      const data = (await res.json()) as { error?: string; referenceId?: string };
      if (!res.ok || !data.referenceId) {
        throw new Error(data.error || "Upload failed");
      }
      onReferenceSelected({ id: data.referenceId, name: file.name });
      onClose();
    } catch (uploadError: unknown) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-label="Reference audio"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(480px, 100%)",
          background: "#ffffff",
          borderRadius: 12,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Reference audio</strong>
          <button type="button" onClick={onClose} aria-label="Close reference">
            ✕
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }} role="tablist" aria-label="Reference source">
          <button type="button" role="tab" aria-selected={tab === "upload"} onClick={() => setTab("upload")}>
            Upload audio
          </button>
          <button type="button" role="tab" aria-selected={tab === "library"} onClick={() => setTab("library")}>
            Library
          </button>
        </div>
        {tab === "upload" ? (
          <form onSubmit={(event) => void handleUpload(event)} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              aria-label="Reference audio file"
              type="file"
              accept="audio/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <button type="submit" disabled={!file || isUploading}>
              {isUploading ? "Uploading..." : "Upload"}
            </button>
            {error ? <p style={{ margin: 0, color: "#b91c1c" }}>{error}</p> : null}
          </form>
        ) : (
          <p style={{ margin: 0, color: "#64748b" }}>No saved references yet.</p>
        )}
      </div>
    </div>
  );
}
