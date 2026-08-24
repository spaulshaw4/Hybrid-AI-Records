/**
 * Process-level mutex + atomic audio writes for the 6-gate pipeline.
 * Prevents concurrent runs for the same trackId and partial file reads.
 */

import fs from "node:fs";
import { dirname, extname, join } from "node:path";

/** Keep the real media extension on atomic temps so FFmpeg can pick a muxer. */
function atomicTempPath(targetPath: string): string {
  const ext = extname(targetPath);
  return `${targetPath}.${Date.now()}.tmp${ext}`;
}

// ==========================================
// 1. In-Memory Process Mutex Lock
// ==========================================

const activeTrackLocks = new Set<string>();

/**
 * Acquire an exclusive in-process lock for `trackId`.
 * @returns true if acquired, false if already processing (caller should HTTP 409).
 */
export function acquireTrackLock(trackId: string): boolean {
  const id = trackId.trim();
  if (!id) return false;
  if (activeTrackLocks.has(id)) {
    console.warn(`[Lock Rejected] Track ${id} is already actively processing.`);
    return false;
  }
  activeTrackLocks.add(id);
  console.log(`[Filing Lock] ACQUIRED track=${id}`);
  return true;
}

export function releaseTrackLock(trackId: string): void {
  const id = trackId.trim();
  if (!id) return;
  if (activeTrackLocks.delete(id)) {
    console.log(`[Filing Lock] RELEASED track=${id}`);
  }
}

export function isTrackLocked(trackId: string): boolean {
  return activeTrackLocks.has(trackId.trim());
}

/** Mapped to HTTP 409 when acquireTrackLock returns false. */
export class TrackLockConflictError extends Error {
  readonly trackId: string;
  readonly statusCode = 409 as const;

  constructor(trackId: string) {
    super(`Track ${trackId} is already generating. Concurrent requests are not allowed.`);
    this.name = "TrackLockConflictError";
    this.trackId = trackId;
  }
}

export function requireTrackLock(trackId: string): void {
  if (!acquireTrackLock(trackId)) {
    throw new TrackLockConflictError(trackId);
  }
}

export function releaseAllTrackLocks(): void {
  if (activeTrackLocks.size === 0) return;
  console.warn(`[Filing Lock] Releasing ${activeTrackLocks.size} lock(s) on process exit`);
  activeTrackLocks.clear();
}

/** Test helper. */
export function __resetTrackLocksForTests(): void {
  activeTrackLocks.clear();
}

// ==========================================
// 2. Safe Atomic File Writer with `.lock` Suffix
// ==========================================

/**
 * Write audio bytes via temp + rename. A `.lock` sidecar blocks readers
 * until the rename completes. Cleans stray `.tmp` / `.lock` in `finally`.
 */
export async function writeAtomicAudioFile(
  targetPath: string,
  data: Buffer | Uint8Array,
): Promise<string> {
  const tempPath = atomicTempPath(targetPath);
  const lockPath = `${targetPath}.lock`;
  await fs.promises.mkdir(dirname(targetPath), { recursive: true });

  try {
    fs.writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
    await fs.promises.writeFile(tempPath, data);
    await fs.promises.rename(tempPath, targetPath);
    return targetPath;
  } finally {
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Produce a file by writing to a temp path then renaming under a `.lock` guard.
 * Used when FFmpeg must write the payload itself.
 */
export async function produceAtomicAudioFile(
  targetPath: string,
  producer: (tmpPath: string) => Promise<void>,
): Promise<string> {
  const tempPath = atomicTempPath(targetPath);
  const lockPath = `${targetPath}.lock`;
  await fs.promises.mkdir(dirname(targetPath), { recursive: true });

  try {
    fs.writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
    await producer(tempPath);
    await fs.promises.rename(tempPath, targetPath);
    return targetPath;
  } finally {
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
  }
}

// ==========================================
// 3. File Read Guard (Wait Until Released)
// ==========================================

export async function waitForFileUnlock(filePath: string, maxWaitMs = 5000): Promise<void> {
  const lockPath = `${filePath}.lock`;
  const start = Date.now();
  while (fs.existsSync(lockPath)) {
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`[Filing Lock] Timeout waiting for file to unlock: ${filePath}`);
    }
    await new Promise((res) => setTimeout(res, 100));
  }
}

/** Best-effort wipe of `.tmp` / `.lock` residue for a path (error unwind). */
export async function cleanupAudioWriteResidue(targetPath: string): Promise<void> {
  const lockPath = `${targetPath}.lock`;
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
  try {
    const dir = dirname(targetPath);
    const baseName = targetPath.slice(dir.length).replace(/^[\\/]/, "");
    const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter(
          (name) =>
            name === `${baseName}.lock` ||
            (name.startsWith(`${baseName}.`) && name.endsWith(".tmp")),
        )
        .map((name) => fs.promises.unlink(join(dir, name)).catch(() => undefined)),
    );
  } catch {
    /* ignore */
  }
}
