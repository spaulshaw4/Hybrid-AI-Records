/**
 * Binary pipeline gate mask — authoritative completion bits for server + studio UI.
 * Clients light badges only from the server-dispatched mask (never predict ahead).
 */

export const PipelineGate = {
  NONE: 0, // 000000 (0)
  COMPOSITION: 1 << 0, // 000001 (1)  - Gate 1: AIMusicAPI
  STORAGE: 1 << 1, // 000010 (2)  - Gate 2: Vault Ingest
  STRUCTURE: 1 << 2, // 000100 (4)  - Gate 3: CWALO
  DEMUX: 1 << 3, // 001000 (8)  - Gate 4: Demucs Stems
  VOCALS: 1 << 4, // 010000 (16) - Gate 5: Fish Audio
  MASTERING: 1 << 5, // 100000 (32) - Gate 6: FFmpeg Mastering
} as const;

/** All six gate bits set — required before post-binary settlement / token debit. */
export const PIPELINE_COMPLETE =
  PipelineGate.COMPOSITION |
  PipelineGate.STORAGE |
  PipelineGate.STRUCTURE |
  PipelineGate.DEMUX |
  PipelineGate.VOCALS |
  PipelineGate.MASTERING; // 63

export type PipelineGateFlag = (typeof PipelineGate)[keyof typeof PipelineGate];

/** Ordered gate bits for UI badges (Gate 1 → 6). */
export const PIPELINE_GATE_ORDER: readonly PipelineGateFlag[] = [
  PipelineGate.COMPOSITION,
  PipelineGate.STORAGE,
  PipelineGate.STRUCTURE,
  PipelineGate.DEMUX,
  PipelineGate.VOCALS,
  PipelineGate.MASTERING,
] as const;

const GATE_NAMES: Record<number, string> = {
  [PipelineGate.NONE]: "none",
  [PipelineGate.COMPOSITION]: "composition",
  [PipelineGate.STORAGE]: "storage",
  [PipelineGate.STRUCTURE]: "structure",
  [PipelineGate.DEMUX]: "demux",
  [PipelineGate.VOCALS]: "vocals",
  [PipelineGate.MASTERING]: "mastering",
};

/** Check if a specific gate is complete */
export const hasPassedGate = (mask: number, gate: number): boolean =>
  (mask & gate) === gate;

/** Mark a gate complete */
export const passGate = (mask: number, gate: number): number => mask | gate;

/**
 * Validate Demucs bit before Gate 5 (Fish Audio).
 * Prefer this over a full COMPOSITION|STORAGE|DEMUX check when only DEMUX is required.
 */
export const canExecuteVocals = (mask: number): boolean =>
  hasPassedGate(mask, PipelineGate.DEMUX);

/** Human / progress-stage name for a single gate flag bit. */
export function getGateNameFromFlag(flag: number): string {
  return GATE_NAMES[flag] ?? `gate:${flag}`;
}

/** Highest completed gate index 0–6 from bitmask (0 = none). */
export function highestPassedGateIndex(mask: number): number {
  let highest = 0;
  PIPELINE_GATE_ORDER.forEach((flag, index) => {
    if (hasPassedGate(mask, flag)) highest = index + 1;
  });
  return highest;
}

/** Progress percent derived only from completed gates (never predicts ahead). */
export function percentFromGateMask(mask: number): number {
  const n = highestPassedGateIndex(mask);
  if (n <= 0) return 0;
  return Math.min(100, Math.round((n / PIPELINE_GATE_ORDER.length) * 100));
}

/** @deprecated Prefer percentFromGateMask */
export const percentFromPipelineState = percentFromGateMask;

/** Map a single gate flag to pipeline-progress stage keys used by the studio bar. */
export function progressStageFromGateFlag(flag: number): string {
  switch (flag) {
    case PipelineGate.COMPOSITION:
      return "composition";
    case PipelineGate.STORAGE:
      return "vault";
    case PipelineGate.STRUCTURE:
      return "cwalo";
    case PipelineGate.DEMUX:
      return "stems";
    case PipelineGate.VOCALS:
      return "vocals";
    case PipelineGate.MASTERING:
      return "master";
    default:
      return getGateNameFromFlag(flag);
  }
}

/** List missing gate names for incomplete masks (rollback diagnostics). */
export function missingGateNames(mask: number): string[] {
  return PIPELINE_GATE_ORDER.filter((flag) => !hasPassedGate(mask, flag)).map(
    getGateNameFromFlag,
  );
}

/** Sequential line-item costs (USD) billed as each billable gate completes. */
export const GATE_LINE_ITEMS = {
  [PipelineGate.COMPOSITION]: { name: "Composition Generation", cost: 1.0 },
  [PipelineGate.STORAGE]: { name: "Vault Ingest", cost: 0.0 },
  [PipelineGate.STRUCTURE]: { name: "Structure Analysis", cost: 0.0 },
  [PipelineGate.DEMUX]: { name: "Stem Separation (Demucs)", cost: 0.5 },
  [PipelineGate.VOCALS]: { name: "Vocal Model Conversion", cost: 0.75 },
  [PipelineGate.MASTERING]: { name: "Mastering & Delivery", cost: 0.25 },
} as const;

export type GateLineItemKey = keyof typeof GATE_LINE_ITEMS;

export type ChargeLedgerEntry = {
  gate: string;
  cost: number;
  timestamp: number;
  gateFlag: number;
};

/** Sum of line-item USD costs on the ledger. */
export function totalChargedFromLedger(ledger: readonly ChargeLedgerEntry[]): number {
  return ledger.reduce((sum, item) => sum + item.cost, 0);
}

/**
 * Append a sequential line charge for `gateFlag` onto `ledger`.
 * No-ops (returns null) when the flag is unknown.
 */
export function chargeLineItem(
  ledger: ChargeLedgerEntry[],
  gateFlag: number,
): ChargeLedgerEntry | null {
  const item = GATE_LINE_ITEMS[gateFlag as GateLineItemKey];
  if (!item) return null;
  const entry: ChargeLedgerEntry = {
    gate: item.name,
    cost: item.cost,
    timestamp: Date.now(),
    gateFlag,
  };
  ledger.push(entry);
  console.log(`[Line Charger] Billed ${item.name}: $${item.cost.toFixed(2)}`);
  return entry;
}
