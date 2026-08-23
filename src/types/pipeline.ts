/**
 * Strict 6-gate studio pipeline contracts.
 * All gate handoffs and landing responses must adhere to these types.
 */

// ==========================================
// 1. GATE STATE MACHINE & TELEMETRY
// ==========================================

export type GateStage =
  | "idle"
  | "gate_1_generating"
  | "gate_2_vaulting"
  | "gate_3_analyzing"
  | "gate_4_splitting"
  | "gate_5_converting"
  | "gate_6_mastering"
  | "landing_success"
  | "landing_fallback"
  | "landing_aborted";

export interface GateTelemetry {
  currentGate: number; // 1 to 6
  totalGates: 6;
  stage: GateStage;
  startTime: number;
  lastUpdated: number;
  retryAttempts: number;
  fallbacksApplied: string[];
}

// ==========================================
// 2. PAYLOAD CONTRACTS (GATE-BY-GATE)
// ==========================================

export interface Gate1Payload {
  trackId: string;
  prompt: string;
  style: string;
}

export interface Gate1Result {
  trackId: string;
  rawAudioBuffer: Buffer;
  mimeType: "audio/mpeg";
}

export interface Gate2Result {
  trackId: string;
  /** Must be a validated HTTPS Supabase CDN URL. */
  publicCdnUrl: string;
  storagePath: string;
}

export interface MusicSectionMarker {
  label: "intro" | "verse" | "chorus" | "bridge" | "solo" | "outro";
  start: number; // seconds
  end: number; // seconds
  energyLevel?: number; // 0.0 to 1.0
}

export interface Gate3Result {
  trackId: string;
  isFallback: boolean;
  markers: MusicSectionMarker[];
  bpm?: number;
  key?: string;
}

export interface Gate4Result {
  trackId: string;
  vocalStemUrl: string;
  backingStemUrl: string;
}

export interface Gate5Result {
  trackId: string;
  convertedVocalBuffer: Buffer;
  /** True if the unmodified Demucs vocal was used. */
  isFallback: boolean;
}

export interface Gate6Result {
  trackId: string;
  masterBuffer: Buffer;
  masterCdnUrl: string;
  durationSeconds: number;
}

// ==========================================
// 3. LANDING CONTRACTS (FINAL UI DELIVERY)
// ==========================================

export interface LandingSuccessResponse {
  status: "success" | "completed_fallback";
  trackId: string;
  masterUrl: string;
  duration: number;
  structuralMarkers: MusicSectionMarker[];
  fallbacksUsed: string[];
  executionTimeMs: number;
}

export interface LandingAbortResponse {
  status: "failed";
  trackId: string;
  failedGate: string;
  error: string;
  executionTimeMs: number;
}

export type PipelineResponse = LandingSuccessResponse | LandingAbortResponse;

/** Well-known fallback telemetry tokens. */
export const FALLBACK_CWALO_DEFAULT_STRUCTURE = "FALLBACK_CWALO_DEFAULT_STRUCTURE";
export const FALLBACK_FISH_AUDIO_RAW_VOCALS = "FALLBACK_FISH_AUDIO_RAW_VOCALS";
export const FALLBACK_STATIC_MASTER_FFMPEG = "FALLBACK_STATIC_MASTER_FFMPEG";

export function createGateTelemetry(partial?: Partial<GateTelemetry>): GateTelemetry {
  const now = Date.now();
  return {
    currentGate: 0,
    totalGates: 6,
    stage: "idle",
    startTime: now,
    lastUpdated: now,
    retryAttempts: 0,
    fallbacksApplied: [],
    ...partial,
  };
}

export function bumpTelemetry(
  telemetry: GateTelemetry,
  gate: number,
  stage: GateStage,
): GateTelemetry {
  return {
    ...telemetry,
    currentGate: gate,
    stage,
    lastUpdated: Date.now(),
  };
}

export function recordFallback(telemetry: GateTelemetry, token: string): GateTelemetry {
  if (telemetry.fallbacksApplied.includes(token)) return telemetry;
  return {
    ...telemetry,
    fallbacksApplied: [...telemetry.fallbacksApplied, token],
    lastUpdated: Date.now(),
  };
}
