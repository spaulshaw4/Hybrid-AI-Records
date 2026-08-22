/**
 * Hybrid Engine on-screen pipeline. The studio shows these four stages
 * while a generate is in flight — never Cancel / Delete mid-render.
 *
 * Storage for the Complete step is `engine-pipeline.server.ts`, which
 * createClient()s with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *
 * Style descriptors for MiniMax / Fish Audio are serialized here from the
 * artist's exact request fields — never a hardcoded genre lock.
 *
 * Audio chain: Base Gen → Demucs split → Fish Audio vocals → Matchering master.
 */

export const ENGINE_PIPELINE_STEPS = [
  {
    id: "stems",
    label: "Stems",
    status: "Generating intro & stems...",
  },
  {
    id: "mixing",
    label: "Mixing",
    status: "Mixing audio stems (FFmpeg)...",
  },
  {
    id: "mastering",
    label: "Mastering",
    status: "Running Matchering 2.0 mastering pass...",
  },
  {
    id: "complete",
    label: "Complete",
    status: "Uploading to vault & preparing player...",
  },
] as const;

export type EnginePipelineStepId = (typeof ENGINE_PIPELINE_STEPS)[number]["id"];

export function enginePipelineStatus(id: EnginePipelineStepId): string {
  return ENGINE_PIPELINE_STEPS.find((step) => step.id === id)?.status ?? ENGINE_PIPELINE_STEPS[0].status;
}

export function enginePipelineIndex(id: EnginePipelineStepId): number {
  const index = ENGINE_PIPELINE_STEPS.findIndex((step) => step.id === id);
  return index < 0 ? 0 : index;
}

/** Artist-selected musical metadata used to build the API style/tags field. */
export type DynamicTagRequest = {
  genre?: string | null;
  subGenre?: string | null;
  mood?: string | null;
  bpm?: number | null;
  instruments?: string[] | null;
  vocalStyle?: string | null;
};

function trimTag(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Universal style serializer. Empty fields are dropped so we never invent a
 * fallback genre, kit, or vocal. The result belongs on the API `prompt` /
 * style field — never prepended onto lyrics.
 */
export function serializeDynamicTags(request: DynamicTagRequest): string {
  const genre = trimTag(request.genre) || null;
  const subGenre = trimTag(request.subGenre) || null;
  const mood = trimTag(request.mood) || null;
  const bpm =
    typeof request.bpm === "number" && Number.isFinite(request.bpm)
      ? `${Math.round(request.bpm)} BPM`
      : null;
  const instruments =
    Array.isArray(request.instruments) && request.instruments.length > 0
      ? request.instruments.map((item) => item.trim()).filter(Boolean).join(", ") || null
      : null;
  const vocalStyle = trimTag(request.vocalStyle);
  const dynamicTags = [
    genre,
    subGenre,
    mood,
    bpm,
    instruments,
    vocalStyle ? `${vocalStyle} vocals` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return dynamicTags;
}

export function logDynamicPayloadDispatch(input: {
  endpoint: string;
  tags: string;
  hasVoiceRef: boolean;
  lyricsLength?: number;
}): void {
  console.log(
    "[DYNAMIC_PAYLOAD_DISPATCH]",
    JSON.stringify(
      {
        endpoint: input.endpoint,
        tags: input.tags,
        hasVoiceRef: input.hasVoiceRef,
        lyricsLength: input.lyricsLength ?? 0,
      },
      null,
      2,
    ),
  );
}
