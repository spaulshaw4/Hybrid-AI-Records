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

export function videoStudioGate(input: { hasAudio: boolean; vision: string }): {
  ok: boolean;
  reason: string | null;
} {
  if (!input.hasAudio) return { ok: false, reason: "Drop your audio track first." };
  if (input.vision.trim().length < 8) {
    return { ok: false, reason: "Describe what happens in the video." };
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
