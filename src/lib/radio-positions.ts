/**
 * Cross-device resume-point conflict resolution.
 *
 * Every play/seek/pause action stamps the track's resume point with the epoch
 * millisecond it happened. When two devices touch the same track, the most
 * recent action wins — regardless of the order the sync payloads arrive in.
 * A late-arriving payload carrying an OLDER action must never overwrite a
 * newer one, which is the whole point of comparing timestamps instead of
 * trusting arrival order.
 */

export type PositionMap = Record<string, number>;
export type PositionTimeMap = Record<string, number>;
/** Which device recorded each resume point, by track key. */
export type PositionDeviceMap = Record<string, string>;

export type PositionState = {
  positions: PositionMap;
  positionTimes: PositionTimeMap;
  positionDevices?: PositionDeviceMap;
};

export type ResolvedPosition = {
  key: string;
  seconds: number;
  /** Epoch ms of the winning action, when the winner carried one. */
  wonAt?: number;
  /** Whether the account payload or this device held the newest action. */
  winner: "remote" | "local";
  /** Human label of the device whose action won, when known. */
  device?: string;
};

export type DeviceWin = { device: string; count: number; side: "remote" | "local" };

export type ResolveResult = PositionState & {
  positionDevices: PositionDeviceMap;
  /** Tracks whose resume point actually moved because of the remote payload. */
  changed: number;
  resolved: ResolvedPosition[];
  /** Per-device tally of who won the compared tracks. */
  winners: DeviceWin[];
};

/** Entries with no timestamp are treated as oldest so a fresh local seek wins. */
function timeOf(times: PositionTimeMap, positions: PositionMap, key: string) {
  return times[key] ?? (key in positions ? 1 : 0);
}

/**
 * Merges a remote (account) snapshot into the local one, per track.
 * Pure: callers own reading/writing storage.
 */
export function resolvePositions(
  local: PositionState,
  remote: Partial<PositionState>,
  localDevice = "This device",
): ResolveResult {
  const remotePos = remote.positions ?? {};
  const remoteTimes = remote.positionTimes ?? {};
  const remoteDevices = remote.positionDevices ?? {};
  const localDevices = local.positionDevices ?? {};
  const positions: PositionMap = { ...local.positions };
  const positionTimes: PositionTimeMap = { ...local.positionTimes };
  const positionDevices: PositionDeviceMap = { ...localDevices };
  const resolved: ResolvedPosition[] = [];
  const tally = new Map<string, DeviceWin>();
  const note = (device: string, side: "remote" | "local") => {
    const id = `${side}:${device}`;
    const found = tally.get(id);
    if (found) found.count += 1;
    else tally.set(id, { device, count: 1, side });
  };
  let changed = 0;

  for (const [key, seconds] of Object.entries(remotePos)) {
    const remoteAt = remoteTimes[key] ?? 0;
    const localAt = timeOf(local.positionTimes, local.positions, key);
    const remoteDevice = remoteDevices[key];
    // Ties keep the local value: the device in front of the listener wins.
    if (key in positions && remoteAt <= localAt) {
      // Only a genuine disagreement counts as a conflict this device won.
      if (positions[key] !== seconds) note(localDevices[key] ?? localDevice, "local");
      continue;
    }

    if (positions[key] !== seconds) {
      changed += 1;
      note(remoteDevice ?? "Another device", "remote");
      resolved.push({
        key,
        seconds: Math.round(seconds * 10) / 10,
        winner: "remote",
        ...(remoteDevice ? { device: remoteDevice } : {}),
        ...(remoteAt ? { wonAt: remoteAt } : {}),
      });
    }
    positions[key] = seconds;
    positionTimes[key] = remoteAt;
    if (remoteDevice) positionDevices[key] = remoteDevice;
  }

  return {
    positions,
    positionTimes,
    positionDevices,
    changed,
    resolved,
    winners: [...tally.values()].sort((a, b) => b.count - a.count),
  };
}


/**
 * Playback events arrive in duplicate all the time: a 500ms ticker firing twice
 * on the same frame, a slider emitting change + input, a re-render replaying a
 * play/pause effect, or the same sync payload being applied again. Applying a
 * duplicate is not just wasted work — restamping a resume point with a fresh
 * timestamp lets a stale value beat a genuinely newer action from another
 * device, and re-issuing a seek to a spot we are already at audibly stutters
 * playback. Both guards below make repeated events no-ops.
 */

/** Two playheads count as the same moment within this many seconds. */
export const SEEK_EPSILON = 0.25;

export function sameMoment(a: number, b: number, epsilon = SEEK_EPSILON) {
  return Math.abs(a - b) < epsilon;
}

/**
 * True when a seek to `target` would actually move the playhead.
 * Duplicate seek events for the current position are dropped.
 */
export function shouldSeek(currentSeconds: number, target: number, epsilon = SEEK_EPSILON) {
  if (!Number.isFinite(target) || target < 0) return false;
  return !sameMoment(currentSeconds, target, epsilon);
}

/**
 * True when a resume point write is a real change worth restamping.
 * `previous` is undefined when the track has no saved point yet.
 */
export function shouldWritePosition(previous: number | undefined, next: number, epsilon = SEEK_EPSILON) {
  if (!Number.isFinite(next) || next < 0) return false;
  if (previous === undefined) return true;
  return !sameMoment(previous, next, epsilon);
}
