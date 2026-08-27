import { useStemMixer } from "@/hooks/useStemMixer";

interface StemDeckProps {
  trackTitle: string;
  bpm: number;
  keySignature: string;
  stems: {
    drums: string;
    bass: string;
    vocals: string;
    other: string;
  };
}

export function StemDeck({ trackTitle, bpm, keySignature, stems }: StemDeckProps) {
  const { isLoaded, isPlaying, volumes, mutes, loadStems, togglePlayback, setStemVolume, toggleMute } =
    useStemMixer();

  return (
    <div style={{ background: "#111", color: "#fff", padding: "24px", borderRadius: "12px", width: "450px" }}>
      <h2 style={{ margin: "0 0 8px 0" }}>{trackTitle}</h2>
      <p style={{ color: "#888", margin: "0 0 16px 0" }}>
        Tempo: <strong>{bpm} BPM</strong> | Key: <strong>{keySignature}</strong>
      </p>
      {!isLoaded ? (
        <button
          type="button"
          onClick={() => loadStems(stems)}
          style={{
            background: "#2563eb",
            color: "#fff",
            padding: "10px 18px",
            borderRadius: "6px",
            border: "none",
            cursor: "pointer",
          }}
        >
          Load Stems into Buffer
        </button>
      ) : (
        <button
          type="button"
          onClick={togglePlayback}
          style={{
            background: isPlaying ? "#dc2626" : "#16a34a",
            color: "#fff",
            padding: "10px 18px",
            borderRadius: "6px",
            border: "none",
            cursor: "pointer",
          }}
        >
          {isPlaying ? "Pause" : "Play All Stems"}
        </button>
      )}
      <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
        {(["drums", "bass", "vocals", "other"] as const).map((stem) => (
          <div
            key={stem}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}
          >
            <span style={{ textTransform: "capitalize", width: "70px" }}>{stem}</span>
            <input
              type="range"
              min="-30"
              max="6"
              value={volumes[stem]}
              onChange={(e) => setStemVolume(stem, Number(e.target.value))}
              disabled={!isLoaded}
            />
            <button
              type="button"
              onClick={() => toggleMute(stem)}
              disabled={!isLoaded}
              style={{
                background: mutes[stem] ? "#ef4444" : "#374151",
                color: "#fff",
                border: "none",
                padding: "4px 8px",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              {mutes[stem] ? "Muted" : "Mute"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
