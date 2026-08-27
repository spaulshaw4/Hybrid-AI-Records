/**
 * Music Structure Inlining — locks dismantled stems onto a master bar timeline.
 *
 * Aligns arrangement blocks (INTRO → … → OUTRO) with start/end bars, active
 * stems, and transition profiles before vault delivery.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import type { DismantelPlacementResult } from "@/lib/IntuitiveDismantelPlacement";

export type SectionName = "INTRO" | "VERSE" | "CHORUS" | "BRIDGE" | "OUTRO";
export type TransitionType = "SWEEP_DROP" | "CROSSFADE" | "HARD_CUT" | "FILTRATION_RISE";

export type ArrangementBlock = {
  sectionName: SectionName;
  barCount: number;
  activeStems: string[];
};

export type InlinedArrangementSegment = {
  section: SectionName;
  startBar: number;
  endBar: number;
  activeStems: string[];
  transitionType: TransitionType;
};

export type InlinedStructureResult = {
  timelineBlueprintId: string;
  totalBars: number;
  inlinedArrangementMap: InlinedArrangementSegment[];
};

export class MusicStructureInlining {
  /**
   * Inlines and aligns dismantled musical components into a synchronized
   * master arrangement timeline, locking bar counts and transition profiles.
   */
  static inlineArrangementStructure(
    ctx: ExecutionContext,
    blocks: ArrangementBlock[],
  ): InlinedStructureResult {
    const timelineBlueprintId = `inline_timeline_${ctx.sessionNonce}_${Date.now()}`;
    let currentBarCursor = 1;
    const inlinedArrangementMap: InlinedArrangementSegment[] = [];
    const safeBlocks = Array.isArray(blocks) ? blocks : [];

    for (let i = 0; i < safeBlocks.length; i += 1) {
      const block = safeBlocks[i];
      const barCount = Math.max(1, Math.trunc(block.barCount || 1));
      const startBar = currentBarCursor;
      const endBar = startBar + barCount - 1;
      currentBarCursor = endBar + 1;

      // Transition profile from structural position / section role.
      let transition: TransitionType = "CROSSFADE";
      if (block.sectionName === "CHORUS") {
        transition = "SWEEP_DROP";
      } else if (block.sectionName === "BRIDGE") {
        transition = "FILTRATION_RISE";
      } else if (block.sectionName === "OUTRO") {
        transition = "HARD_CUT";
      } else if (block.sectionName === "INTRO") {
        transition = "FILTRATION_RISE";
      }

      inlinedArrangementMap.push({
        section: block.sectionName,
        startBar,
        endBar,
        activeStems: Array.isArray(block.activeStems)
          ? block.activeStems.map((s) => String(s))
          : [],
        transitionType: transition,
      });
    }

    return {
      timelineBlueprintId,
      totalBars: Math.max(0, currentBarCursor - 1),
      inlinedArrangementMap,
    };
  }

  /**
   * Build a standard pop/electronic form from dismantel stem names + tier.
   */
  static deriveBlocksFromDismantel(
    ctx: ExecutionContext,
    dismantel: DismantelPlacementResult,
  ): ArrangementBlock[] {
    const stemNames =
      dismantel.reallocatedStems?.map((s) => s.stemName).filter(Boolean) ?? [];
    const all = stemNames.length > 0 ? stemNames : ["drums", "bass", "harmony"];
    const rhythm = all.filter((s) => s === "drums" || s === "bass");
    const body = all.filter((s) => s !== "fx");
    const full = all;

    const introBars = ctx.tier === "enterprise" ? 8 : 4;
    const verseBars = ctx.tier === "free" ? 8 : 16;
    const chorusBars = ctx.tier === "enterprise" ? 16 : 8;
    const bridgeBars = ctx.tier === "free" ? 4 : 8;
    const outroBars = 4;

    return [
      {
        sectionName: "INTRO",
        barCount: introBars,
        activeStems: rhythm.length > 0 ? rhythm : all.slice(0, 2),
      },
      {
        sectionName: "VERSE",
        barCount: verseBars,
        activeStems: body.length > 0 ? body : all,
      },
      {
        sectionName: "CHORUS",
        barCount: chorusBars,
        activeStems: full,
      },
      {
        sectionName: "BRIDGE",
        barCount: bridgeBars,
        activeStems: all.filter((s) => s === "harmony" || s === "fx" || s === "lead"),
      },
      {
        sectionName: "OUTRO",
        barCount: outroBars,
        activeStems: rhythm.length > 0 ? [...rhythm, "fx"].filter((s, i, a) => a.indexOf(s) === i) : all,
      },
    ].map((block) => ({
      ...block,
      activeStems:
        block.activeStems.length > 0
          ? block.activeStems
          : all,
    }));
  }
}
