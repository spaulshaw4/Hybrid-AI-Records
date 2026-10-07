import { useEffect, useRef, useState } from "react";

import { MurekaStudioForm, type GeneratePayload } from "@/components/studio/MurekaStudioForm";
import { supabase } from "@/integrations/supabase/client";
import { waitForVaultedTrack } from "@/lib/wavespeed-track-client";

const handleDownload = async (url: string, filename: string) => {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(blobUrl);
  } catch (err) {
    window.open(url, "_blank");
  }
};

export default function MurekaStudio() {
  const [isLoading, setIsLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [wavUrl, setWavUrl] = useState<string | null>(null);
  const [mp3Url, setMp3Url] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const monitorUrl = mp3Url || wavUrl || "";

  useEffect(() => {
    if (audioRef.current && monitorUrl) {
      audioRef.current.src = monitorUrl;
      audioRef.current.load();
    }
  }, [monitorUrl]);

  async function onGenerate(payload: GeneratePayload) {
    setIsLoading(true);
    setStatusText("Submitting to MusiCoT engine...");
    setWavUrl(null);
    setMp3Url(null);
    setTitle(payload.title);
    try {
      let userId: string | null = null;
      let accessToken = "";
      try {
        const { data: auth } = await supabase.auth.getSession();
        userId = auth.session?.user?.id ?? null;
        accessToken = auth.session?.access_token?.trim() ?? "";
      } catch {
        userId = null;
      }
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          ...payload,
          ...(userId ? { userId } : {}),
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        status?: string;
        taskId?: string;
        wavUrl?: string;
        mp3Url?: string | null;
        error?: string;
      };
      let wavUrl = typeof data.wavUrl === "string" ? data.wavUrl : "";
      let mp3Url = typeof data.mp3Url === "string" ? data.mp3Url : "";
      if (res.ok && data.success && data.status === "pending" && data.taskId) {
        setStatusText("Rendering master...");
        const ready = await waitForVaultedTrack(data.taskId);
        wavUrl = ready.wavUrl;
        mp3Url = ready.mp3Url;
      }
      if (!res.ok || !wavUrl) {
        throw new Error(data.error || "Generation failed upstream");
      }
      setWavUrl(wavUrl);
      setMp3Url(mp3Url || null);
      setStatusText("Master complete");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Request failed";
      alert(message);
      setStatusText("");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 20px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Hybrid Audio Studio</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>Engine: Mureka V9.5</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(280px, 0.8fr)", gap: 24, alignItems: "start" }}>
        <MurekaStudioForm onGenerate={onGenerate} isLoading={isLoading} />
        <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 16px" }}>Monitor & Output</h2>
          {isLoading ? (
            <p style={{ fontSize: 14, fontWeight: 600, color: "#4b5563" }}>{statusText}</p>
          ) : null}
          {!isLoading && !wavUrl ? (
            <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 13 }}>Ready to compose.</p>
          ) : null}
          {wavUrl ? (
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{title || "Untitled Master"}</div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 16 }}>Permanent Audio Vault (Dual Delivery)</div>
              <audio ref={audioRef} controls src={monitorUrl || undefined} style={{ width: "100%", marginBottom: 16 }} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
                <button
                  type="button"
                  onClick={() => {
                    if (!wavUrl) return;
                    void handleDownload(wavUrl, `${title || "master"}.wav`);
                  }}
                  style={{
                    padding: "10px 0",
                    background: "#0f172a",
                    border: "1px solid #334155",
                    color: "#f8fafc",
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                    width: "100%",
                  }}
                >
                  ↓ Download WAV
                </button>
                {mp3Url ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleDownload(mp3Url, `${title || "master"}.mp3`);
                    }}
                    style={{
                      padding: "10px 0",
                      background: "#1e293b",
                      border: "1px solid #475569",
                      color: "#f8fafc",
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      width: "100%",
                    }}
                  >
                    ↓ Download MP3
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
