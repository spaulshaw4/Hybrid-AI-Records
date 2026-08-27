/**
 * Generation factory / switchboard.
 *
 * Resolves the active AudioGenerationProvider from env (or an explicit name)
 * so the worker and queue never hardcode a vendor.
 */

import type { AudioGenerationProvider } from "@/lib/generation-providers/AudioGenerationProvider";
import { HybridEngineProvider } from "@/lib/generation-providers/HybridEngineProvider";
import { ThirdPartyApiProvider } from "@/lib/generation-providers/ThirdPartyApiProvider";

export type GenerationProviderName = "hybrid-engine" | "third-party-wrapper";

export class GenerationFactory {
  /**
   * Returns the configured generation backend.
   * Default: `hybrid-engine` (full Gates 1–6). Set
   * `ACTIVE_GENERATION_PROVIDER=third-party-wrapper` for raw Sonic-only.
   */
  static getProvider(providerName?: string): AudioGenerationProvider {
    const active =
      (providerName || process.env.ACTIVE_GENERATION_PROVIDER || "hybrid-engine").trim() ||
      "hybrid-engine";

    switch (active) {
      case "third-party-wrapper":
        return new ThirdPartyApiProvider();
      case "hybrid-engine":
        return new HybridEngineProvider();
      // case "proprietary-engine":
      //   return new ProprietaryEngineProvider();
      default:
        throw new Error(`Unknown generation provider: ${active}`);
    }
  }

  static listProviders(): GenerationProviderName[] {
    return ["hybrid-engine", "third-party-wrapper"];
  }
}
