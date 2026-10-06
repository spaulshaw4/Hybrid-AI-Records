import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export default function MurekaStudio() {
  const [isInstrumental, setIsInstrumental] = useState(false);
  const [title, setTitle] = useState("Heavy Sky Arrival");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [vocalId, setVocalId] = useState("");
  const [bpm, setBpm] = useState(74);
  const [stylePrompt, setStylePrompt] = useState(
    "Heavy southern rock, driving rhythm, raw gritty male vocal, wide stereo guitars, live kit"
  );
  const [lyrics, setLyrics] = useState(`[intro-long]
[Verse 1]
Walking slow down through the valley floor
Footsteps heavy by the iron door
Counting miles that we left behind
Searching hard for what is mine
[Chorus]
All or nothing under heavy sky
Stand your ground and don't ask why
We don't break and we don't back down
Carving thunder through this town
[Verse 2]
Rims of fire on the mountain crest
Feel the hammer beating in the chest
No more running from the cold north wind
This is where the fight begins
[Chorus]
All or nothing under heavy sky
Stand your ground and don't ask why
We don't break and we don't back down
Carving thunder through this town
[inst-long]
[Bridge]
Take a breath when the shadows fall
Put your back against the wall
Nothing left that we cannot take
Every promise that we make
[Chorus - Double]
All or nothing under heavy sky
Stand your ground and don't ask why
We don't break and we don't back down
Carving thunder through this town
Yeah we stand under heavy sky
We don't break and we don't back down
[outro-long]
[Final Chord]
[Fade Out]`);
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [wavUrl, setWavUrl] = useState<string | null>(null);
  const [mp3Url, setMp3Url] = useState<string | null>(null);
  // Structural tag inserter matching Mureka's lyric assistant
  const insertTag = (tag: string) => {
    setLyrics((prev) => `${prev}\n\n${tag}\n`);
  };
  const insertStyleTag = (tag: string) => {
    setStylePrompt((prev) => (prev ? `${prev}, ${tag}` : tag));
  };
  async function handleCreate() {
    setLoading(true);
    setStatusText("Submitting to MusiCoT engine...");
    setWavUrl(null);
    setMp3Url(null);
    try {
      const lyricsText = isInstrumental ? "" : lyrics;
      const trimmedVocalId = vocalId.trim();
      let userId: string | null = null;
      try {
        const { data: auth } = await supabase.auth.getUser();
        userId = auth.user?.id ?? null;
      } catch {
        userId = null;
      }
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          prompt: stylePrompt,
          lyrics: lyricsText,
          gender,
          vocalId: trimmedVocalId,
          isInstrumental,
          ...(userId ? { userId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.wavUrl) {
        throw new Error(data.error || "Generation failed upstream");
      }
      setWavUrl(data.wavUrl);
      setMp3Url(data.mp3Url);
      setStatusText("Master complete");
    } catch (err: any) {
      alert(err.message || "Request failed");
      setStatusText("");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 20px", fontFamily: "system-ui, sans-serif" }}>
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, borderBottom: "1px solid #e5e7eb", paddingBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Hybrid Audio Studio</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0 0" }}>Engine: Mureka V9.5 (300 Concurrency Lanes)</p>
        </div>
        <div style={{ display: "flex", background: "#f3f4f6", padding: 4, borderRadius: 8 }}>
          <button
            onClick={() => setIsInstrumental(false)}
            style={{
              padding: "8px 18px",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              background: !isInstrumental ? "#ffffff" : "transparent",
              boxShadow: !isInstrumental ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            }}
          >
            Vocal Song
          </button>
          <button
            onClick={() => setIsInstrumental(true)}
            style={{
              padding: "8px 18px",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              background: isInstrumental ? "#ffffff" : "transparent",
              boxShadow: isInstrumental ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            }}
          >
            Instrumental BGM
          </button>
        </div>
      </div>
      {/* Main Two-Column Studio Workspace */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 32 }}>
        {/* Left Column: Mureka Form Controls */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Track Title */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Song Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter song title..."
              style={{ width: "100%", padding: "10px 12px", marginTop: 6, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 14 }}
            />
          </div>
          {/* Lyrics Box & Structure Buttons */}
          {!isInstrumental && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Lyrics & Structure</label>
                {/* Structure Quick Tags */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {["[Verse]", "[Chorus]", "[Bridge]", "[inst-long]", "[outro-long]"].map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => insertTag(tag)}
                      style={{ fontSize: 11, padding: "3px 8px", background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 4, cursor: "pointer" }}
                    >
                      + {tag}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                rows={12}
                value={lyrics}
                onChange={(e) => setLyrics(e.target.value)}
                style={{ width: "100%", padding: 12, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, fontFamily: "monospace", lineHeight: 1.5 }}
              />
            </div>
          )}
          {/* Style Prompt & Tag Helpers */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Style of Music (Prompt)</label>
              <div style={{ display: "flex", gap: 6 }}>
                {["Acoustic Intro", "Gritty Male Vocal", "Live Drum Kit", "Stereo Riffs"].map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => insertStyleTag(tag)}
                    style={{ fontSize: 11, padding: "3px 8px", background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 4, cursor: "pointer" }}
                  >
                    + {tag}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              rows={3}
              value={stylePrompt}
              onChange={(e) => setStylePrompt(e.target.value)}
              placeholder="Genre, mood, instruments, dynamic progression..."
              style={{ width: "100%", padding: 10, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
            />
          </div>
          {/* Vocal & Tempo Fine-Tuning */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {!isInstrumental && (
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Vocal Profile</label>
                <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                  {(["male", "female"] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setGender(g)}
                      style={{
                        flex: 1,
                        padding: "8px 0",
                        borderRadius: 6,
                        border: "1px solid #d1d5db",
                        background: gender === g ? "#111827" : "#ffffff",
                        color: gender === g ? "#ffffff" : "#374151",
                        fontSize: 13,
                        fontWeight: 600,
                        textTransform: "capitalize",
                        cursor: "pointer",
                      }}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Tempo (BPM)</label>
              <input
                type="number"
                value={bpm}
                min={50}
                max={220}
                onChange={(e) => setBpm(Number(e.target.value))}
                style={{ width: "100%", padding: "8px 12px", marginTop: 6, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 14 }}
              />
            </div>
          </div>
          {!isInstrumental && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Artist Voice ID (Optional)</label>
              <input
                type="text"
                placeholder="Leave blank for default, or paste existing Vocal ID"
                value={vocalId}
                onChange={(e) => setVocalId(e.target.value)}
                style={{ width: "100%", padding: "8px 12px", marginTop: 6, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
              />
            </div>
          )}
          {/* Primary Render Action */}
          <button
            onClick={handleCreate}
            disabled={loading}
            style={{
              marginTop: 10,
              padding: "16px 0",
              background: loading ? "#9ca3af" : "#111827",
              color: "#ffffff",
              fontSize: 15,
              fontWeight: 700,
              border: "none",
              borderRadius: 8,
              cursor: loading ? "not-allowed" : "pointer",
              boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
            }}
          >
            {loading ? "Synthesizing Master (~60-90s)..." : "Generate Master Track ($0.225)"}
          </button>
        </div>
        {/* Right Column: Output Monitor */}
        <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 24, height: "fit-content" }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 16px 0", color: "#111827" }}>Monitor & Output</h3>
          {loading && (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#4b5563" }}>{statusText}</div>
              <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 8 }}>MusiCoT arrangement and stereo mastering in progress.</p>
            </div>
          )}
          {!loading && !wavUrl && (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af", fontSize: 13 }}>
              Ready to compose. Click Generate to trigger your first master.
            </div>
          )}
          {wavUrl && (
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 4 }}>
                {title || "Untitled Master"}
              </div>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 16 }}>
                Permanent Audio Vault (Dual Delivery)
              </div>
              <audio controls src={mp3Url || wavUrl} style={{ width: "100%", marginBottom: 16 }} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
                <a href={wavUrl} target="_blank" download={`${title || "master"}.wav`} style={{ display: "block", textAlign: "center", padding: "10px 0", background: "#111827", color: "#ffffff", borderRadius: 6, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
                  Download WAV
                </a>
                {mp3Url && (
                  <a href={mp3Url} target="_blank" download={`${title || "master"}.mp3`} style={{ display: "block", textAlign: "center", padding: "10px 0", background: "#ffffff", border: "1px solid #d1d5db", color: "#111827", borderRadius: 6, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
                    Download MP3
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
