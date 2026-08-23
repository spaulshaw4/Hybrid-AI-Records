import { describe, expect, it } from "vitest";
import {
  PIPELINE_COMPLETE,
  PipelineGate,
  GATE_LINE_ITEMS,
  canExecuteVocals,
  chargeLineItem,
  hasPassedGate,
  missingGateNames,
  passGate,
  percentFromGateMask,
  totalChargedFromLedger,
  type ChargeLedgerEntry,
} from "@/lib/pipeline-flags";

describe("pipeline binary gate mask", () => {
  it("uses the documented bit layout and complete mask 63", () => {
    expect(PipelineGate.COMPOSITION).toBe(1);
    expect(PipelineGate.STORAGE).toBe(2);
    expect(PipelineGate.STRUCTURE).toBe(4);
    expect(PipelineGate.DEMUX).toBe(8);
    expect(PipelineGate.VOCALS).toBe(16);
    expect(PipelineGate.MASTERING).toBe(32);
    expect(PIPELINE_COMPLETE).toBe(63);
  });

  it("passGate / hasPassedGate OR bits without predicting ahead", () => {
    let mask: number = PipelineGate.NONE;
    expect(hasPassedGate(mask, PipelineGate.DEMUX)).toBe(false);
    mask = passGate(mask, PipelineGate.COMPOSITION);
    mask = passGate(mask, PipelineGate.STORAGE);
    expect(canExecuteVocals(mask)).toBe(false);
    mask = passGate(mask, PipelineGate.DEMUX);
    expect(canExecuteVocals(mask)).toBe(true);
    expect(percentFromGateMask(mask)).toBeLessThan(100);
    mask = passGate(
      passGate(passGate(mask, PipelineGate.STRUCTURE), PipelineGate.VOCALS),
      PipelineGate.MASTERING,
    );
    expect(mask).toBe(PIPELINE_COMPLETE);
    expect(missingGateNames(mask)).toEqual([]);
  });

  it("sequential line charger records billable gates", () => {
    const ledger: ChargeLedgerEntry[] = [];
    chargeLineItem(ledger, PipelineGate.COMPOSITION);
    chargeLineItem(ledger, PipelineGate.DEMUX);
    chargeLineItem(ledger, PipelineGate.MASTERING);
    expect(ledger).toHaveLength(3);
    expect(totalChargedFromLedger(ledger)).toBeCloseTo(1.75);
    expect(GATE_LINE_ITEMS[PipelineGate.VOCALS].cost).toBe(0.75);
  });
});
