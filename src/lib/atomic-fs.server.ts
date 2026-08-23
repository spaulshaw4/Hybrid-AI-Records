/**
 * Re-exports atomic write helpers (canonical home: track-lock.server.ts).
 * Kept so existing imports of `@/lib/atomic-fs.server` keep working.
 */

export {
  writeAtomicAudioFile,
  produceAtomicAudioFile,
  waitForFileUnlock,
  cleanupAudioWriteResidue,
} from "@/lib/track-lock.server";

export { writeAtomicAudioFile as atomicWriteFile } from "@/lib/track-lock.server";
