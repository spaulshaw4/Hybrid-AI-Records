/** Barrel for audio generation provider abstraction. */
export {
  AudioGenerationProvider,
  type GenerationRequestPayload,
  type GenerationResult,
} from "@/lib/generation-providers/AudioGenerationProvider";
export { ThirdPartyApiProvider } from "@/lib/generation-providers/ThirdPartyApiProvider";
export { HybridEngineProvider } from "@/lib/generation-providers/HybridEngineProvider";
export {
  GenerationFactory,
  type GenerationProviderName,
} from "@/lib/generation-providers/GenerationFactory";
