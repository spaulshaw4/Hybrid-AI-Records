/** Hidden timing labels. The canvas never shows these. */
export type TimelineMarker = {
  label: "verse" | "chorus" | "bridge" | "drop";
  start: number;
  end: number;
};

export function timelineMarkersFromSections(
  sections: { start: number; end: number; label: string }[],
  duration: number,
): TimelineMarker[] {
  if (!sections.length || duration < 4) return evenTimelineMarkers(duration);
  const markers = sections
    .map((section) => {
      const name = section.label.toLowerCase();
      const label: TimelineMarker["label"] = /chorus|hook|refrain/.test(name)
        ? "chorus"
        : /bridge/.test(name)
          ? "bridge"
          : /drop/.test(name)
            ? "drop"
            : "verse";
      return {
        label,
        start: Math.max(0, section.start),
        end: Math.min(duration, section.end),
      };
    })
    .filter((marker) => marker.end - marker.start >= 1);
  return markers.length > 0 ? markers : evenTimelineMarkers(duration);
}

export function evenTimelineMarkers(durationSeconds: number): TimelineMarker[] {
  const duration = Math.max(4, durationSeconds);
  const count = duration >= 24 ? 4 : duration >= 12 ? 2 : 1;
  const slice = duration / count;
  const labels: TimelineMarker["label"][] = ["verse", "chorus", "verse", "chorus"];
  return Array.from({ length: count }, (_, index) => ({
    label: labels[index] ?? "verse",
    start: Number((index * slice).toFixed(2)),
    end: Number((index === count - 1 ? duration : (index + 1) * slice).toFixed(2)),
  }));
}

export type ScriptMode = "auto" | "manual";

export type ScriptSlot = {
  label: string;
  start: number;
  end: number;
};

const SECTION_NAMES: Record<string, string> = {
  intro: "Intro",
  build: "Build",
  verse: "Verse",
  chorus: "Chorus",
  drop: "Drop",
  breakdown: "Breakdown",
  outro: "Outro",
  bridge: "Bridge",
};

export function scriptSlotsFromSections(
  sections: { start: number; end: number; label: string }[],
  duration: number,
): ScriptSlot[] {
  const detected = sections
    .filter((section) => section.end - section.start >= 1)
    .slice(0, 16)
    .map((section) => ({
      label: SECTION_NAMES[section.label.toLowerCase()] ?? "Verse",
      start: section.start,
      end: section.end,
    }));
  if (detected.length > 0) return detected;
  if (duration < 4) return [];
  return evenTimelineMarkers(duration).map((marker) => ({
    label: SECTION_NAMES[marker.label] ?? "Verse",
    start: marker.start,
    end: marker.end,
  }));
}

export function formatSlotTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = Math.round(safe % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function videoStudioGate(input: {
  hasAudio: boolean;
  mode: ScriptMode;
  vision: string;
  shots: string[];
}): { ok: boolean; reason: string | null } {
  if (!input.hasAudio) return { ok: false, reason: "Drop your audio track first." };
  if (input.mode === "manual") {
    if (input.shots.length === 0) return { ok: false, reason: "Drop a track to see the sections." };
    if (input.shots.some((shot) => shot.trim().length < 3)) {
      return { ok: false, reason: "Describe each section." };
    }
    return { ok: true, reason: null };
  }
  if (input.vision.trim().length < 8) {
    return { ok: false, reason: "Describe your video concept." };
  }
  return { ok: true, reason: null };
}

/** The photo is the reference. The canvas does not invent a character name. */
export const STAR_DESCRIPTION =
  "The person in the uploaded photograph. Keep their face, skin tone, hair, and styling.";

/** The render API still wants a short script. A one-line concept is enough on screen. */
export function visionScript(vision: string): string {
  const text = vision.trim();
  if (text.length >= 40) return text.slice(0, 15000);
  return `${text}\n\nHold one continuous visual world for the full music video.`;
}
