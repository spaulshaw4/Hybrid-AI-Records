import { useEffect, useRef, useState } from "react";
import { useMemo } from "react";
import { AlertTriangle, Check, CloudCheck, Download, Eye, Loader2, Upload, Link2, LogIn, Plus, RotateCcw, Trash2, Pause, Play, RefreshCw, Shuffle, SkipBack, SkipForward, X } from "lucide-react";
import { applyMixStyle, dedupeTracks, type MixStyle } from "@/lib/radio-tracks";
import { supabase } from "@/integrations/supabase/client";
import { loadRadioSettings, saveRadioSettings } from "@/lib/radio-sync.functions";
import { useDivisionNames } from "@/lib/division-settings";
import type { Division } from "@/lib/divisions";
import { resolvePositions, shouldSeek, shouldWritePosition, type DeviceWin, type ResolvedPosition } from "@/lib/radio-positions";
import { toast } from "sonner";
import {
  claimCatalogPlayback,
  getCatalogAudioElement,
} from "@/lib/catalog-player";
import { fetchRadioReadyTracks } from "@/lib/fetch-artist-catalog.client";
import { playableToRadioTrack } from "@/lib/artist-catalog";

import { deviceLabel } from "@/lib/radio-device";
import {
  RETRY_LOG_EVENT,
  classifyRetryError,
  failRetryAttempt,
  finishRetryAttempt,
  readRetryLog,
  startRetryAttempt,
  type RetryAttempt,
} from "@/lib/radio-retry-log";
import { WaveSeek } from "@/components/WaveSeek";
import { CoverImage } from "@/components/CoverImage";
import { SyncBadge, agoLabel } from "@/components/radio/SyncBadge";
import {
  SyncHistoryPanel,
  HISTORY_LABELS,
  type SyncEvent,
  type SyncEventKind,
  type SyncFailure,
} from "@/components/radio/SyncHistoryPanel";
import { ArtistTokenStore, useArtistTokens } from "@/components/ArtistTokenStore";





export type RadioTrack = {
  id: string;
  title: string;
  artist: string;
  src?: string;
  cover?: string;
  credits?: string;
  album?: string;
  genre?: string;
  trackNumber?: number;
  trackTotal?: number;
  division?: Division;
};

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<void> | null = null;
function loadYT(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

const MIX_STYLES: { value: MixStyle; label: string; hint: string }[] = [
  { value: "artist", label: "By Artist", hint: "Balanced rotation — no two songs by the same artist back to back" },
  { value: "genre", label: "By Genre", hint: "Balanced rotation across genres" },
  { value: "shuffle", label: "Shuffle", hint: "Fully shuffled playlist" },
];

function fmt(s: number) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const RADIO_SETTINGS_KEY = "hybrid-radio-settings";

/** Which repeat rules a variety burst is allowed to switch off. */
export type RelaxRules = { artist: boolean; genre: boolean };

/** A saved variety burst: how many tracks, and which guards it relaxes. */
export type RelaxPreset = {
  id: string;
  name: string;
  count: number;
  rules: RelaxRules;
};

const DEFAULT_RELAX_PRESETS: RelaxPreset[] = [
  { id: "quick-3", name: "Quick Burst", count: 3, rules: { artist: true, genre: true } },
  { id: "artist-5", name: "Artist Free-For-All", count: 5, rules: { artist: true, genre: false } },
];

function sanitizeRelaxPresets(value: unknown): RelaxPreset[] | null {
  if (!Array.isArray(value)) return null;
  const list = value
    .map((p: any): RelaxPreset | null => {
      if (!p || typeof p !== "object") return null;
      const count = Math.max(1, Math.min(50, Math.round(Number(p.count))));
      if (!Number.isFinite(count)) return null;
      const artist = p?.rules?.artist !== false;
      const genre = p?.rules?.genre !== false;
      if (!artist && !genre) return null;
      return {
        id: typeof p.id === "string" && p.id ? p.id : `preset-${Math.random().toString(36).slice(2, 9)}`,
        name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 32) : `${count}-Track Burst`,
        count,
        rules: { artist, genre },
      };
    })
    .filter((p): p is RelaxPreset => p !== null)
    .slice(0, 12);
  return list;
}

type StoredRadioSettings = {
  mixStyle: MixStyle;
  shuffle: boolean;
  trackKey: string | null;
  queue: string[];
  mixSeed: number;
  spacing: number;
  /** How many tracks ahead the Up Next window shows. */
  upNext: number;
  /** Show the "why this track" rule inline for every queued song. */
  showReasons: boolean;
  /** Minimal mode — collapse badges and extra metadata by default. */
  minimal: boolean;
  /** Which metadata fields are visible on the now-playing row. */
  metaFields: Partial<Record<MetaField, boolean>>;
  /** Saved variety-burst presets. */
  relaxPresets: RelaxPreset[];
  /** When this device last made an intentional change (ISO timestamp). */
  updatedAt: string;
};

/** Metadata rows/badges the listener can switch on or off while playing. */
type MetaField = "title" | "artist" | "album" | "genre" | "division" | "credits";
const META_FIELDS: { value: MetaField; label: string; hint: string }[] = [
  { value: "title", label: "Title", hint: "Track title" },
  { value: "artist", label: "Artist", hint: "Artist line" },
  { value: "album", label: "Album", hint: "Album badge with track number" },
  { value: "genre", label: "Genre", hint: "Genre badge" },
  { value: "division", label: "Division", hint: "Label division badge" },
  { value: "credits", label: "Credits", hint: "Writer / production credits" },
];
const DEFAULT_META_FIELDS: Record<MetaField, boolean> = {
  title: true,
  artist: true,
  album: true,
  genre: true,
  division: true,
  credits: true,
};

function sanitizeMetaFields(value: unknown): Record<MetaField, boolean> | null {
  if (!value || typeof value !== "object") return null;
  const out = { ...DEFAULT_META_FIELDS };
  let touched = false;
  for (const f of META_FIELDS) {
    const v = (value as Record<string, unknown>)[f.value];
    if (typeof v === "boolean") {
      out[f.value] = v;
      touched = true;
    }
  }
  return touched ? out : null;
}


const UP_NEXT_OPTIONS = [5, 10, 20] as const;

/** Console panels — only one is open at a time so the player stays uncluttered. */
type PanelKey = "none" | "mix" | "queue" | "tracks" | "history" | "display";
const PANELS = [
  { value: "mix" as const, label: "Mix Controls" },
  { value: "queue" as const, label: "Up Next" },
  { value: "tracks" as const, label: "Tracklist" },
  { value: "history" as const, label: "Sync History" },
  { value: "display" as const, label: "Display" },
];

/** Per-track audit trail of play/seek actions and cross-device resolutions. */
const RADIO_HISTORY_KEY = "hybrid-radio-sync-history";
const HISTORY_LIMIT = 150;
const HISTORY_EVENT = "hybrid-radio-history";

// SyncEvent / SyncEventKind now live with the panel that renders them.



function readSyncHistory(): SyncEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RADIO_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as SyncEvent[]) : [];
  } catch {
    return [];
  }
}

/**
 * Trims history to HISTORY_LIMIT, but never drops the latest resolved
 * timestamp for a track — those rows back the "Resolved Timestamps" panel and
 * must survive reloads even after a long tail of play/pause/seek noise.
 */
function pruneSyncHistory(events: SyncEvent[]): SyncEvent[] {
  if (events.length <= HISTORY_LIMIT) return events;
  const keptResolved = new Set<SyncEvent>();
  const seenTracks = new Set<string>();
  for (const e of events) {
    if (e.kind !== "resolved" || seenTracks.has(e.key)) continue;
    seenTracks.add(e.key);
    keptResolved.add(e);
  }
  const head = events.slice(0, HISTORY_LIMIT);
  const missing = [...keptResolved].filter((e) => !head.includes(e));
  if (!missing.length) return head;
  // Newest-first ordering is preserved by re-sorting after re-attaching.
  return [...head, ...missing].sort((a, b) => b.at - a.at);
}

function logSyncEvents(events: SyncEvent[]) {
  if (typeof window === "undefined" || !events.length) return;
  const next = pruneSyncHistory([...events, ...readSyncHistory()]);
  try {
    window.localStorage.setItem(RADIO_HISTORY_KEY, JSON.stringify(next));
  } catch {}
  window.dispatchEvent(new CustomEvent(HISTORY_EVENT));
}


function logSyncEvent(key: string, kind: SyncEventKind, seconds: number, wonAt?: number) {
  if (!key) return;
  const last = readSyncHistory()[0];
  // Collapse repeat noise: same track + same action within 3s and ~1s of playhead.
  if (
    last &&
    last.key === key &&
    last.kind === kind &&
    Date.now() - last.at < 3000 &&
    Math.abs(last.seconds - seconds) < 1
  ) {
    return;
  }
  logSyncEvents([{ key, kind, seconds: Math.round(seconds * 10) / 10, at: Date.now(), ...(wonAt ? { wonAt } : {}) }]);
}

/** Failed cross-device resolutions, kept until a retry succeeds. */
const RADIO_FAILURES_KEY = "hybrid-radio-sync-failures";
const FAILURES_EVENT = "hybrid-radio-failures";
const FAILURES_LIMIT = 20;


/** Reads the last reconciliation result without local narrowing. */
type LastResolution = { tracks: number; device?: string };
function readLastResolution(ref: { current: LastResolution | null }): LastResolution | null {
  return ref.current;
}

function readSyncFailures(): SyncFailure[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RADIO_FAILURES_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as SyncFailure[]) : [];
  } catch {
    return [];
  }
}

function writeSyncFailures(next: SyncFailure[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RADIO_FAILURES_KEY, JSON.stringify(next.slice(0, FAILURES_LIMIT)));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(FAILURES_EVENT));
}









const RADIO_POSITIONS_KEY = "hybrid-radio-positions";
const RADIO_POSITION_TIMES_KEY = "hybrid-radio-position-times";
const RADIO_POSITION_DEVICES_KEY = "hybrid-radio-position-devices";
/** How often we flush resume points to localStorage while a track plays. */
const POSITION_PERSIST_MS = 8_000;

type PositionCache = {
  map: Record<string, number>;
  times: Record<string, number>;
  devices: Record<string, string>;
};

let positionCache: PositionCache | null = null;
let lastPositionPersistAt = 0;

function parseRecord(raw: string | null): Record<string, number> {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function parseStringRecord(raw: string | null): Record<string, string> {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Per-track resume points: { "<trackKey>": seconds }. */
function readPositions(): Record<string, number> {
  if (typeof window === "undefined") return {};
  if (positionCache) return positionCache.map;
  try {
    return parseRecord(window.localStorage.getItem(RADIO_POSITIONS_KEY));
  } catch {
    return {};
  }
}

/**
 * When each resume point was last set on this device (epoch ms).
 * Conflict resolution is per track: the most recent play/seek action wins, so a
 * stale seek arriving from another device can never overwrite a newer one.
 */
function readPositionTimes(): Record<string, number> {
  if (typeof window === "undefined") return {};
  if (positionCache) return positionCache.times;
  try {
    return parseRecord(window.localStorage.getItem(RADIO_POSITION_TIMES_KEY));
  } catch {
    return {};
  }
}

/** Which device recorded each stored resume point (human label). */
function readPositionDevices(): Record<string, string> {
  if (typeof window === "undefined") return {};
  if (positionCache) return positionCache.devices;
  try {
    return parseStringRecord(window.localStorage.getItem(RADIO_POSITION_DEVICES_KEY));
  } catch {
    return {};
  }
}

function loadPositionCache(): PositionCache {
  if (positionCache) return positionCache;
  positionCache = {
    map: readPositions(),
    times: readPositionTimes(),
    devices: readPositionDevices(),
  };
  return positionCache;
}

function persistPositionCache(force = false) {
  if (typeof window === "undefined" || !positionCache) return;
  const now = Date.now();
  if (!force && now - lastPositionPersistAt < POSITION_PERSIST_MS) return;
  lastPositionPersistAt = now;
  try {
    window.localStorage.setItem(RADIO_POSITIONS_KEY, JSON.stringify(positionCache.map));
    window.localStorage.setItem(RADIO_POSITION_TIMES_KEY, JSON.stringify(positionCache.times));
    window.localStorage.setItem(RADIO_POSITION_DEVICES_KEY, JSON.stringify(positionCache.devices));
  } catch {
    /* private mode / quota */
  }
}

function writePosition(key: string, seconds: number, duration: number, force = false) {
  if (typeof window === "undefined" || !key) return;
  const cache = loadPositionCache();
  const { map, times, devices } = cache;
  // Only drop the very start and the tail — everything else resumes exactly.
  if (seconds < 2 || (duration > 0 && seconds > duration - 5)) {
    if (map[key] === undefined || map[key] === 0) return;
    // Keep the key as an explicit "cleared" marker so the timestamp still
    // beats an older resume point coming back from another device.
    map[key] = 0;
  } else {
    // Keep tenths of a second so playback picks up on the same beat.
    const next = Math.round(seconds * 10) / 10;
    // Duplicate event for a spot we already saved: leave the stored timestamp
    // alone so it can't out-rank a newer action from another device.
    if (!shouldWritePosition(map[key], next)) return;
    map[key] = next;
  }
  times[key] = Date.now();
  devices[key] = deviceLabel();
  persistPositionCache(force);
}





const trackKeyOf = (t: { id: string; title: string }) => `${t.id}::${t.title}`;

function readRadioSettings(): Partial<StoredRadioSettings> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RADIO_SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads mix settings shared through the URL (?mix=…&seed=…&gap=…&sh=…). */
function readSharedSettings(): Partial<StoredRadioSettings> | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("mix") && !params.has("seed") && !params.has("gap")) return null;
  const mix = params.get("mix");
  const seed = Number(params.get("seed"));
  const gap = Number(params.get("gap"));
  return {
    mixStyle: mix === "artist" || mix === "genre" || mix === "shuffle" ? mix : undefined,
    mixSeed: Number.isFinite(seed) ? seed : undefined,
    spacing: Number.isFinite(gap) && gap >= 1 && gap <= 5 ? Math.round(gap) : undefined,
    shuffle: params.get("sh") === "1" ? true : params.get("sh") === "0" ? false : undefined,
  } as Partial<StoredRadioSettings>;
}

function writeAllPositions(
  map: Record<string, number>,
  times?: Record<string, number>,
  devices?: Record<string, string>,
) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RADIO_POSITIONS_KEY, JSON.stringify(map));
    if (times) window.localStorage.setItem(RADIO_POSITION_TIMES_KEY, JSON.stringify(times));
    if (devices) window.localStorage.setItem(RADIO_POSITION_DEVICES_KEY, JSON.stringify(devices));
  } catch {}
}

/**
 * Merges account resume points with this device's, track by track: whichever
 * side recorded the most recent play/seek action for a track wins. See
 * `resolvePositions` in @/lib/radio-positions for the resolution rules.
 */
function mergePositions(remote: {
  positions?: Record<string, number>;
  positionTimes?: Record<string, number>;
  positionDevices?: Record<string, string>;
}) {
  const result = resolvePositions(
    {
      positions: readPositions(),
      positionTimes: readPositionTimes(),
      positionDevices: readPositionDevices(),
    },
    remote,
    deviceLabel(),
  );
  logSyncEvents(
    result.resolved.map((r) => ({
      key: r.key,
      kind: "resolved" as const,
      seconds: r.seconds,
      at: Date.now(),
      winner: r.winner,
      ...(r.device ? { device: r.device } : {}),
      ...(r.wonAt ? { wonAt: r.wonAt } : {}),
    })),
  );

  writeAllPositions(result.positions, result.positionTimes, result.positionDevices);

  return {
    positions: result.positions,
    changed: result.changed,
    winners: result.winners,
    resolved: result.resolved,
  };

}








export function RadioPlayer({ tracks: incomingTracks }: { tracks: RadioTrack[] }) {
  // Prefer live radio_ready rows from artist_tracks (CDN audio_url).
  const [stationTracks, setStationTracks] = useState<RadioTrack[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchRadioReadyTracks();
        if (cancelled) return;
        const mapped = rows.map(playableToRadioTrack).filter((t) => Boolean(t.src));
        console.log("[radio] feeding queue from artist_tracks.radio_ready", mapped.length);
        setStationTracks(mapped);
      } catch (error) {
        console.error("[radio] artist_tracks queue fetch failed:", error);
        if (!cancelled) setStationTracks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Account sync: when a listener is signed in, their mix travels with them.
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<"idle" | "loading" | "synced">("idle");
  const remoteLoadedRef = useRef(false);
  // Latest settings snapshot + a dirty flag so resume points can be pushed to
  // the account on their own schedule (not just when a control changes).
  const accountEmailRef = useRef<string | null>(null);
  accountEmailRef.current = accountEmail;
  const syncPayloadRef = useRef<{
    mixStyle: MixStyle;
    shuffle: boolean;
    spacing: number;
    mixSeed: number;
    trackKey: string | null;
    queue: string[];
  } | null>(null);
  const positionsDirtyRef = useRef(false);
  // Latest observed playhead, so a track switch or play/pause can persist the
  // exact moment we left off even between ticker writes.
  const lastPlaybackRef = useRef<{ key: string; time: number; duration: number } | null>(null);
  // "Resume from 1:23" confirmation for a track with a saved timestamp.
  const [resumePrompt, setResumePrompt] = useState<{ key: string; seconds: number } | null>(null);
  // Bumped when account resume points land, to re-seek the loaded track.
  const [resumeNonce, setResumeNonce] = useState(0);
  // Conflict resolution: the account keeps whichever device made the most
  // recent intentional edit, so every write carries this device's edit stamp.
  const lastEditRef = useRef<string>(new Date(0).toISOString());
  const firstPersistRef = useRef(true);
  const applyingRemoteRef = useRef(false);
  const [conflictNotice, setConflictNotice] = useState(false);
  // Small status indicator shown while devices reconcile timestamps.
  const [resolveState, setResolveState] = useState<{
    phase: "resolving" | "resolved" | "error";
    tracks: number;
    message?: string;
    /** Which device's action won each reconciled track. */
    winners?: DeviceWin[];
  } | null>(null);
  const resolveTimers = useRef<number[]>([]);
  const retryResolve = useRef<() => void>(() => {});
  const [retrying, setRetrying] = useState(false);
  // Last time devices were successfully aligned, so the badge can show it.
  const [lastResolvedAt, setLastResolvedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("hybrid-radio-last-resolved");
      if (raw) setLastResolvedAt(Number(raw) || null);
    } catch {
      /* ignore */
    }
  }, []);
  // Keeps the "aligned 3m ago" label fresh without a full re-render loop.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);
  // Failed resolutions, surfaced in the Sync History panel until a retry clears them.
  const [syncFailures, setSyncFailures] = useState<SyncFailure[]>([]);
  useEffect(() => {
    const refresh = () => setSyncFailures(readSyncFailures());
    refresh();
    window.addEventListener(FAILURES_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(FAILURES_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  // Retry attempt log: each Retry press with its device, and how it settled.
  const [retryLog, setRetryLog] = useState<RetryAttempt[]>([]);
  useEffect(() => {
    const refresh = () => setRetryLog(readRetryLog());
    refresh();
    window.addEventListener(RETRY_LOG_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(RETRY_LOG_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  /** Id of the retry attempt awaiting its outcome, if a retry is in flight. */
  const pendingRetryRef = useRef<string | null>(null);
  /** Last reconciliation result, so a retry can be logged with what it fixed. */
  const lastResolutionRef = useRef<{ tracks: number; device?: string } | null>(null);
  // Title lookup for toasts; kept in a ref so noteResolution stays stable.
  const trackTitlesRef = useRef<Record<string, string>>({});
  const noteResolution = useRef<(tracks: number, winners?: DeviceWin[], resolved?: ResolvedPosition[]) => void>(
    () => {},
  );
  noteResolution.current = (tracks, winners, resolved) => {
    resolveTimers.current.forEach((t) => window.clearTimeout(t));
    resolveTimers.current = [];
    setResolveState({ phase: "resolving", tracks, winners });
    lastResolutionRef.current = { tracks, ...(resolved?.[0]?.device ? { device: resolved[0].device } : {}) };
    // A successful reconciliation clears any recorded failure.
    if (readSyncFailures().length) writeSyncFailures([]);
    resolveTimers.current.push(
      window.setTimeout(() => {
        const at = Date.now();
        setResolveState({ phase: "resolved", tracks, winners });
        setLastResolvedAt(at);
        setNowTick(at);
        try {
          window.localStorage.setItem("hybrid-radio-last-resolved", String(at));
        } catch {
          /* ignore */
        }
        // Tell the listener which device's action won and where it resumes.
        const top = resolved?.[0];
        if (top) {
          const device = top.device ?? (top.winner === "remote" ? "another device" : "this device");
          const title = trackTitlesRef.current[top.key] ?? "This track";
          const extra = resolved.length > 1 ? ` +${resolved.length - 1} more` : "";
          toast.success("Playback synced across devices", {
            id: "radio-resolution",
            description: `${title} · resumes at ${fmt(top.seconds)} · ${device} won${extra}`,
          });
        }
      }, 800),
      window.setTimeout(() => setResolveState(null), 6000),
    );
  };



  // Resolution failed (network, bad payload) — the badge stays until retried.
  const noteResolveError = useRef<(message: string) => void>(() => {});
  noteResolveError.current = (message) => {
    resolveTimers.current.forEach((t) => window.clearTimeout(t));
    resolveTimers.current = [];
    setResolveState({ phase: "error", tracks: 0, message });
    writeSyncFailures([{ at: Date.now(), message }, ...readSyncFailures()]);
  };
  useEffect(() => () => resolveTimers.current.forEach((t) => window.clearTimeout(t)), []);


  // Applies an account snapshot without treating it as a local edit.
  const adoptRemote = useRef<(remote: Awaited<ReturnType<typeof loadRadioSettings>>) => void>(() => {});
  const handleSaveResult = useRef<(res: any) => void>(() => {});
  handleSaveResult.current = (res) => {
    if (res && res.conflict && res.settings) {
      // A newer edit exists on another device — take it instead of clobbering.
      noteResolution.current(0);
      adoptRemote.current(res.settings);
      setConflictNotice(true);
      window.setTimeout(() => setConflictNotice(false), 6000);
    }
    setSyncState("synced");
  };


  const pushPositions = useRef(() => {});
  pushPositions.current = () => {
    const base = syncPayloadRef.current;
    if (!accountEmailRef.current || !base || !positionsDirtyRef.current) return;
    positionsDirtyRef.current = false;
    void saveRadioSettings({
      data: {
        ...base,
        positions: readPositions(),
        positionTimes: readPositionTimes(),
        positionDevices: readPositionDevices(),
        clientUpdatedAt: lastEditRef.current,
      },

    })
      .then((res) => handleSaveResult.current(res))

      .catch(() => {
        positionsDirtyRef.current = true;
      });
  };

  const divisionNames = useDivisionNames();
  // Never play the same song twice in one broadcast, and deal the songs out as
  // a mixed rotation instead of one album at a time.
  // Only one detail panel is open at a time — the console starts clean.
  const [openPanel, setOpenPanel] = useState<PanelKey>("none");
  // Artist Tokens ($1 each) — one token unlocks one permanent track download.
  const artistTokens = useArtistTokens();

  // Per-track audit trail, kept in sync with the local log.
  const [syncHistory, setSyncHistory] = useState<SyncEvent[]>([]);
  useEffect(() => {
    const refresh = () => setSyncHistory(readSyncHistory());
    refresh();
    window.addEventListener(HISTORY_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(HISTORY_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Dev/test hook: lets an end-to-end test hand this device an account
  // snapshot recorded by a second simulated device, exercising the real
  // conflict-resolution and Sync History code paths without a signed-in user.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    w["__hybridRadioAdoptRemote"] = (remote: unknown) => adoptRemote.current(remote as never);
    // Simulates a resolution failure on this device (network / bad payload).
    w["__hybridRadioFailResolve"] = (message?: string) =>
      noteResolveError.current(message || "Couldn't reach your account to resolve playback timestamps.");
    return () => {
      delete w["__hybridRadioAdoptRemote"];
      delete w["__hybridRadioFailResolve"];
    };
  }, []);




  const [mixStyle, setMixStyle] = useState<MixStyle>("artist");

  const [mixSeed, setMixSeed] = useState(0);
  const [spacing, setSpacing] = useState(1);
  // Size of the Up Next window (tracks ahead), saved with the mix settings.
  const [upNext, setUpNext] = useState(10);
  // Inline rotation explanations for every queued song, not just on hover.
  const [showReasons, setShowReasons] = useState(true);
  // Minimal mode: collapse the badge row and extra metadata for a calm console.
  const [minimal, setMinimal] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  // Which metadata fields the listener wants on the now-playing row.
  const [metaFields, setMetaFields] = useState<Record<MetaField, boolean>>(DEFAULT_META_FIELDS);
  // Temporary variety burst: relax the no-same-artist/genre guard for the next
  // N tracks, then snap back to the saved Repeat Guard automatically.
  const [relaxRemaining, setRelaxRemaining] = useState(0);
  const [relaxSize, setRelaxSize] = useState(3);
  // Which guards the running burst switched off, plus the listener's saved presets.
  const [relaxRules, setRelaxRules] = useState<RelaxRules>({ artist: true, genre: true });
  const [relaxPresets, setRelaxPresets] = useState<RelaxPreset[]>(DEFAULT_RELAX_PRESETS);
  const [previewPresetId, setPreviewPresetId] = useState<string | null>(null);
  const [presetNotice, setPresetNotice] = useState("");
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [presetFormOpen, setPresetFormOpen] = useState(false);
  const [presetDraft, setPresetDraft] = useState<{ name: string; count: number; rules: RelaxRules }>({
    name: "",
    count: 5,
    rules: { artist: true, genre: true },
  });
  const relaxed = relaxRemaining > 0;
  // A burst only loosens the guard for the rule the current mix is built on.
  const guardRelaxed = relaxed && (mixStyle === "genre" ? relaxRules.genre : relaxRules.artist);
  const effectiveSpacing = guardRelaxed ? 0 : spacing;

  const tracks = useMemo(() => {
    const source =
      stationTracks && stationTracks.length > 0
        ? stationTracks
        : incomingTracks.filter((t) => Boolean(t.src));
    const fallback = source.length ? source : incomingTracks;
    return applyMixStyle(dedupeTracks(fallback), mixStyle, mixSeed, effectiveSpacing);
  }, [stationTracks, incomingTracks, mixStyle, mixSeed, effectiveSpacing]);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [ready, setReady] = useState(false);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  // Playback readiness: buffering blocks sound, buffered marks how much of the
  // track is already downloaded so the seek bar can show a "loaded" band.
  const [buffering, setBuffering] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [shuffle, setShuffle] = useState(false);
  const orderRef = useRef<number[]>([]);
  const advanceRef = useRef<() => void>(() => {});
  const pendingRestoreRef = useRef<{ trackKey: string | null; queue: string[] } | null>(null);
  // Restored settings are applied after mount so SSR markup and the first
  // client render stay identical.
  const [restored, setRestored] = useState(false);
  // Listeners review the mixed rotation first, then confirm to start the broadcast.
  const [confirmed, setConfirmed] = useState(false);

  // Bind the shared catalog HTMLAudioElement so Artist page / album / Radio
  // all play the same public CDN URLs through one element.
  useEffect(() => {
    const el = getCatalogAudioElement();
    if (!el) return;
    audioRef.current = el;
    claimCatalogPlayback("radio");

    const onPlay = () => {
      claimCatalogPlayback("radio");
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);
    const onEnded = () => advanceRef.current();
    const onLoadStart = () => setBuffering(true);
    const onWaiting = () => setBuffering(true);
    const onStalled = () => setBuffering(true);
    const onSeeking = () => setBuffering(true);
    const onSeeked = () => setBuffering(false);
    const onCanPlay = () => setBuffering(false);
    const onPlaying = () => setBuffering(false);
    const onError = () => setBuffering(false);
    const onProgress = () => {
      setBuffered(el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0);
    };
    const onLoadedMetadata = () => {
      setDuration(el.duration || 0);
      setBuffering(false);
    };

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("loadstart", onLoadStart);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("stalled", onStalled);
    el.addEventListener("seeking", onSeeking);
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("error", onError);
    el.addEventListener("progress", onProgress);
    el.addEventListener("loadedmetadata", onLoadedMetadata);

    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("loadstart", onLoadStart);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("stalled", onStalled);
      el.removeEventListener("seeking", onSeeking);
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("error", onError);
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, []);

  adoptRemote.current = (remote) => {
    if (!remote) return;
    // Mark as a remote apply so the persist effect doesn't stamp it as a new
    // local edit and start a ping-pong between devices.
    applyingRemoteRef.current = true;
    lastEditRef.current = remote.updatedAt;
    setMixStyle(remote.mixStyle);
    setShuffle(remote.shuffle);
    setSpacing(remote.spacing);
    setMixSeed(remote.mixSeed);
    pendingRestoreRef.current = { trackKey: remote.trackKey, queue: remote.queue };
    if (remote.positions && Object.keys(remote.positions).length) {
      // Per track, the most recent play/seek wins — an older account timestamp
      // never overwrites a newer local one.
      try {
        const { changed, winners, resolved } = mergePositions(remote);
        if (changed || winners.length) noteResolution.current(changed, winners, resolved);

        // Re-apply the resume point only when something actually moved; a
        // duplicate payload must not re-seek the track that is already playing.

        if (changed) setResumeNonce((n) => n + 1);
      } catch {
        noteResolveError.current("Couldn't compare playback timestamps from your other devices.");
      }
    }



  };

  // Keeps toast copy able to name the track that was reconciled.
  useEffect(() => {
    trackTitlesRef.current = Object.fromEntries(tracks.map((t) => [trackKeyOf(t), t.title]));
  }, [tracks]);

  // Dev/test hook: exposes the mixed rotation's track keys so an end-to-end
  // test can target a track other than the one currently playing.
  useEffect(() => {

    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>)["__hybridRadioTrackKeys"] = tracks.map(trackKeyOf);
    return () => {
      delete (window as unknown as Record<string, unknown>)["__hybridRadioTrackKeys"];
    };
  }, [tracks]);

  useEffect(() => {
    // A shared link wins over locally saved settings so both listeners hear
    // the exact same rotation.
    const shared = readSharedSettings();
    const local = readRadioSettings() ?? {};
    const saved = { ...local, ...(shared ?? {}) };
    // A shared link is an intentional change made right now; a plain reload
    // carries forward whenever this device last changed something.
    lastEditRef.current = shared
      ? new Date().toISOString()
      : typeof local.updatedAt === "string" && !Number.isNaN(Date.parse(local.updatedAt))
        ? local.updatedAt
        : new Date(0).toISOString();
    if (saved) {
      if (saved.mixStyle === "artist" || saved.mixStyle === "genre" || saved.mixStyle === "shuffle") {
        setMixStyle(saved.mixStyle);
      }
      if (typeof saved.shuffle === "boolean") setShuffle(saved.shuffle);
      if (typeof saved.mixSeed === "number" && Number.isFinite(saved.mixSeed)) setMixSeed(saved.mixSeed);
      if (typeof saved.spacing === "number" && saved.spacing >= 1 && saved.spacing <= 5) {
        setSpacing(Math.round(saved.spacing));
      }
      if (typeof saved.upNext === "number" && UP_NEXT_OPTIONS.includes(Math.round(saved.upNext) as never)) {
        setUpNext(Math.round(saved.upNext));
      }
      if (typeof saved.showReasons === "boolean") setShowReasons(saved.showReasons);
      if (typeof saved.minimal === "boolean") setMinimal(saved.minimal);
      const fields = sanitizeMetaFields(saved.metaFields);
      if (fields) setMetaFields(fields);
      const presets = sanitizeRelaxPresets(saved.relaxPresets);
      if (presets) setRelaxPresets(presets);

      pendingRestoreRef.current = {
        trackKey: typeof saved.trackKey === "string" ? saved.trackKey : null,
        queue: Array.isArray(saved.queue) ? saved.queue.filter((k) => typeof k === "string") : [],
      };
    }
    setRestored(true);
  }, []);

  // Watch the session, then reconcile the account copy with this device's copy:
  // whichever holds the most recent intentional edit wins.
  useEffect(() => {
    let active = true;
    const applyRemote = async (email: string | null) => {
      if (!active) return;
      // A retry press opened a log entry; this pass owns its outcome.
      const attemptId = pendingRetryRef.current;
      pendingRetryRef.current = null;
      setAccountEmail(email);
      if (!email || remoteLoadedRef.current) {
        if (attemptId && !email) failRetryAttempt(attemptId, "Not signed in — no account to sync with.", "no-account");
        else if (attemptId) finishRetryAttempt(attemptId, 0);
        return;
      }
      // Offline: the locally restored queue and Up Next window stand on their own.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setSyncState("idle");
        if (attemptId) failRetryAttempt(attemptId, "This device is offline.", "offline");
        return;
      }
      setSyncState("loading");
      lastResolutionRef.current = null;
      try {
        const remote = await loadRadioSettings();
        if (!active) return;
        remoteLoadedRef.current = true;
        if (remote) {
          const remoteAt = Date.parse(remote.updatedAt);
          const localAt = Date.parse(lastEditRef.current);
          if (!Number.isFinite(localAt) || remoteAt >= localAt) {
            adoptRemote.current(remote);
          } else {
            // This device holds the newer intent — keep it and push it up.
            if (remote.positions && Object.keys(remote.positions).length) {
              try {
                const { changed, winners, resolved } = mergePositions(remote);
                if (changed || winners.length) noteResolution.current(changed, winners, resolved);

              } catch {
                noteResolveError.current("Couldn't compare playback timestamps from your other devices.");
              }
            }


            positionsDirtyRef.current = true;
            window.setTimeout(() => pushPositions.current(), 0);
          }
        }
        setSyncState("synced");
        if (attemptId) {
          const merge = readLastResolution(lastResolutionRef);
          const failed = readSyncFailures()[0];
          // A merge error inside this pass still counts as a failed retry.
          if (failed) failRetryAttempt(attemptId, failed.message);
          else finishRetryAttempt(attemptId, merge?.tracks ?? 0, merge?.device);
        }
      } catch (err) {
        if (active) {
          setSyncState("idle");
          remoteLoadedRef.current = false;
          const detail = err instanceof Error && err.message ? err.message : "";
          noteResolveError.current("Couldn't reach your account to resolve playback timestamps.");
          if (attemptId) {
            failRetryAttempt(
              attemptId,
              detail || "Couldn't reach your account to resolve playback timestamps.",
              classifyRetryError(detail || "reach your account"),
            );
          }
        }
      } finally {
        if (active) setRetrying(false);
      }
    };
    retryResolve.current = () => {
      setRetrying(true);
      setResolveState(null);
      // Clear the recorded failures: a fresh attempt either succeeds or logs anew.
      if (readSyncFailures().length) writeSyncFailures([]);
      remoteLoadedRef.current = false;
      pendingRetryRef.current = startRetryAttempt(deviceLabel(), accountEmailRef.current);
      supabase.auth.getSession().then(({ data }) => {
        const email = data.session?.user.email ?? null;
        void applyRemote(email);
        if (!email) setRetrying(false);
      });

    };




    supabase.auth.getSession().then(({ data }) => applyRemote(data.session?.user.email ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        remoteLoadedRef.current = false;
        setAccountEmail(null);
        setSyncState("idle");
        return;
      }
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
        void applyRemote(session?.user.email ?? null);
      }
    });
    // Came back online — reconcile with the account then.
    const onOnline = () => {
      supabase.auth.getSession().then(({ data }) => applyRemote(data.session?.user.email ?? null));
    };
    window.addEventListener("online", onOnline);
    return () => {
      active = false;
      window.removeEventListener("online", onOnline);
      sub.subscription.unsubscribe();
    };
  }, []);


  // Once the (possibly restored) mix style has produced its track list, restore
  // the saved queue order and the track the listener left off on.
  useEffect(() => {
    if (!restored) return;
    const pending = pendingRestoreRef.current;
    if (!pending || !tracks.length) return;
    pendingRestoreRef.current = null;

    const keys = tracks.map(trackKeyOf);
    const order = pending.queue
      .map((key) => keys.indexOf(key))
      .filter((i) => i >= 0);
    if (order.length === tracks.length) orderRef.current = order;

    if (pending.trackKey) {
      const target = keys.indexOf(pending.trackKey);
      if (target >= 0) setIdx(target);
    }
  }, [restored, tracks]);

  // Persist mix mode, shuffle state, queue order and position.
  useEffect(() => {
    if (!restored || typeof window === "undefined" || !tracks.length) return;
    const keys = tracks.map(trackKeyOf);

    // The first run after restoring is not an edit — it just re-saves what was
    // already there, so it must not out-rank another device's newer change.
    if (firstPersistRef.current) {
      firstPersistRef.current = false;
    } else if (!applyingRemoteRef.current) {
      lastEditRef.current = new Date().toISOString();
    }
    applyingRemoteRef.current = false;

    const payload: StoredRadioSettings = {
      mixStyle,
      mixSeed,
      spacing,
      upNext,
      showReasons,
      minimal,
      metaFields,
      relaxPresets,

      shuffle,
      trackKey: keys[idx] ?? null,
      queue: orderRef.current.length === tracks.length ? orderRef.current.map((i) => keys[i]) : [],
      updatedAt: lastEditRef.current,
    };
    try {
      window.localStorage.setItem(RADIO_SETTINGS_KEY, JSON.stringify(payload));
    } catch {}

    const remotePayload = {
      mixStyle,
      shuffle,
      spacing,
      mixSeed,
      trackKey: payload.trackKey,
      queue: payload.queue,
    };
    syncPayloadRef.current = remotePayload;

    if (!accountEmail || syncState === "loading") return;
    // Debounced so quick control changes result in one write.
    const t = window.setTimeout(() => {
      positionsDirtyRef.current = false;
      void saveRadioSettings({
        data: {
          ...remotePayload,
          positions: readPositions(),
          positionTimes: readPositionTimes(),
          positionDevices: readPositionDevices(),
          clientUpdatedAt: lastEditRef.current,
        },

      })
        .then((res) => handleSaveResult.current(res))
        .catch(() => {});
    }, 1200);
    return () => window.clearTimeout(t);
  }, [restored, mixStyle, mixSeed, spacing, upNext, showReasons, minimal, metaFields, relaxPresets, shuffle, idx, tracks, accountEmail, syncState]);


  // Push the live playback timestamp to the account periodically and whenever
  // the listener pauses, hides the tab or leaves the page.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const iv = window.setInterval(() => {
      if (!playingRef.current) return;
      if (document.visibilityState === "hidden") return;
      pushPositions.current();
    }, 10000);
    const flush = () => {
      persistPositionCache(true);
      pushPositions.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, []);


  const track = tracks[idx];
  const isAudio = !!track?.src;
  // Refs so the progress ticker always sees the live track / play state.
  const trackRef = useRef(track);
  trackRef.current = track;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  /** True once the listener has pressed play — gates any automatic playback. */
  const userStartedRef = useRef(false);

  const ytCreatedRef = useRef(false);
  useEffect(() => {
    if (track?.src) return;
    if (ytCreatedRef.current) return;
    ytCreatedRef.current = true;
    let cancelled = false;
    loadYT().then(() => {
      if (cancelled || !mountRef.current) return;
      playerRef.current = new window.YT.Player(mountRef.current, {
        height: "0",
        width: "0",
        videoId: tracks.find((t) => !t.src)?.id,
        playerVars: { playsinline: 1, controls: 0, disablekb: 1, modestbranding: 1 },
        events: {
          onReady: () => setReady(true),
          onStateChange: (e: any) => {
            const YT = window.YT;
            if (audioRef.current && !audioRef.current.paused) return;
            setPlaying(e.data === YT.PlayerState.PLAYING);
            setBuffering(e.data === YT.PlayerState.BUFFERING);
            if (e.data === YT.PlayerState.ENDED) {
              advanceRef.current();
            }
          },
        },
      });
    });
    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy?.();
      } catch {}
      ytCreatedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.src]);

  // Load track when idx changes
  const firstLoad = useRef(true);
  useEffect(() => {
    const t = tracks[idx];
    if (!t) return;
    const audio = audioRef.current;
    // Never start audio on page load: only auto-start a newly loaded track once
    // the listener has actually pressed play at least once this session.
    const autoplay = !firstLoad.current && userStartedRef.current;
    firstLoad.current = false;

    // Switching tracks: bank the outgoing track's exact timestamp first.
    const last = lastPlaybackRef.current;
    if (last && last.key !== trackKeyOf(t)) {
      writePosition(last.key, last.time, last.duration, true);
      positionsDirtyRef.current = true;
      pushPositions.current();
    }
    lastPlaybackRef.current = null;

    const resumeAt = readPositions()[trackKeyOf(t)] ?? 0;
    setResumePrompt(resumeAt > 2 ? { key: trackKeyOf(t), seconds: resumeAt } : null);
    setBuffered(0);
    setBuffering(true);

    if (t.src) {
      try {
        playerRef.current?.pauseVideo?.();
      } catch {}
      if (audio) {
        audio.src = t.src;
        audio.load();
        setCurrent(resumeAt);
        setDuration(0);
        const applyResume = () => {
          // Skip the seek when the element already sits on the resume point —
          // a repeated resume must not restart the buffer.
          if (
            resumeAt > 0 &&
            isFinite(audio.duration) &&
            resumeAt < audio.duration - 5 &&
            shouldSeek(audio.currentTime || 0, resumeAt)
          ) {
            try {
              audio.currentTime = resumeAt;
            } catch {}
          }

          if (autoplay) audio.play().catch(() => setPlaying(false));
        };
        audio.addEventListener("loadedmetadata", applyResume, { once: true });
      }
      return;
    }

    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    if (!ready || !playerRef.current) return;
    try {
      if (autoplay) playerRef.current.loadVideoById({ videoId: t.id, startSeconds: resumeAt });
      else playerRef.current.cueVideoById({ videoId: t.id, startSeconds: resumeAt });
      if (resumeAt > 0) setCurrent(resumeAt);
    } catch {}
  }, [idx, ready, tracks, resumeNonce]);

  // Progress ticker — only while playing and the tab is visible. A paused
  // player does not need a 2 Hz React clock on a 3k-line tree.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      const audio = audioRef.current;
      const key = trackRef.current ? trackKeyOf(trackRef.current) : "";
      if (isAudio) {
        if (!audio) return;
        const time = audio.currentTime || 0;
        const dur = isFinite(audio.duration) ? audio.duration : 0;
        setCurrent(time);
        setDuration(dur);
        setBuffered(audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0);
        if (key) lastPlaybackRef.current = { key, time, duration: dur };
        if (!audio.paused) {
          writePosition(key, time, dur);
          positionsDirtyRef.current = true;
        }
        return;
      }
      const p = playerRef.current;
      if (!p || !p.getCurrentTime) return;
      try {
        const time = p.getCurrentTime() || 0;
        const dur = p.getDuration() || 0;
        setCurrent(time);
        setDuration(dur);
        const frac = p.getVideoLoadedFraction ? p.getVideoLoadedFraction() || 0 : 0;
        setBuffered(frac * dur);
        if (key) lastPlaybackRef.current = { key, time, duration: dur };
        if (playingRef.current) {
          writePosition(key, time, dur);
          positionsDirtyRef.current = true;
        }
      } catch {}
    };
    const iv = setInterval(tick, 500);
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isAudio, playing]);

  // Play and pause are both strong "this is where I am" signals — persist the
  // exact timestamp right away so other signed-in devices stay aligned.
  useEffect(() => {
    const last = lastPlaybackRef.current;
    if (last) {
      writePosition(last.key, last.time, last.duration, true);
      positionsDirtyRef.current = true;
      logSyncEvent(last.key, playing ? "play" : "pause", last.time);
    } else {
      const t = trackRef.current;
      if (t && playing) logSyncEvent(trackKeyOf(t), "play", 0);
    }

    pushPositions.current();
  }, [playing]);



  const confirmPlay = () => {
    setConfirmed(true);
    toggle();
  };

  const toggle = () => {
    setConfirmed(true);
    userStartedRef.current = true;
    if (isAudio) {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) audio.play().catch(() => setPlaying(false));
      else audio.pause();
      return;
    }
    const p = playerRef.current;
    if (!p) return;
    if (playing) p.pauseVideo();
    else p.playVideo();
  };
  // Shuffle: keeps a random play order so no track repeats until the list wraps.
  const buildOrder = (start: number) => {
    const rest = tracks.map((_, i) => i).filter((i) => i !== start);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    orderRef.current = [start, ...rest];
  };

  const step = (dir: 1 | -1) =>
    setIdx((i) => {
      if (!tracks.length) return i;
      if (!shuffle) return (i + dir + tracks.length) % tracks.length;
      let order = orderRef.current;
      if (order.length !== tracks.length || order.indexOf(i) === -1) {
        buildOrder(i);
        order = orderRef.current;
      }
      const pos = order.indexOf(i);
      return order[(pos + dir + order.length) % order.length];
    });

  const selectMixStyle = (style: MixStyle) => {
    if (style === mixStyle) return;
    setMixStyle(style);
    setIdx(0);
    orderRef.current = [];
  };

  // "Up next" explainer: why the queue picked the song that follows this one.
  const upcoming = (() => {
    if (!tracks.length) return [] as { index: number; track: RadioTrack }[];
    const order =
      shuffle && orderRef.current.length === tracks.length && orderRef.current.indexOf(idx) !== -1
        ? orderRef.current
        : tracks.map((_, i) => i);
    const pos = order.indexOf(idx);
    const count = Math.min(upNext, tracks.length - 1);
    const list: { index: number; track: RadioTrack }[] = [];
    for (let step = 1; step <= count; step++) {
      const index = order[(pos + step) % order.length];
      list.push({ index, track: tracks[index] });
    }
    return list;
  })();
  // Preset preview: rebuild the rotation as if the hovered preset were applied
  // and diff it against the queue that is showing right now.
  const previewPreset = relaxPresets.find((p) => p.id === previewPresetId) ?? null;
  const relaxPreview = (() => {
    if (!previewPreset || mixStyle === "shuffle" || !track || !tracks.length) return null;
    const relaxesActive = mixStyle === "genre" ? previewPreset.rules.genre : previewPreset.rules.artist;
    const nextSpacing = relaxesActive ? 0 : spacing;
    const list = applyMixStyle(dedupeTracks(incomingTracks), mixStyle, mixSeed, nextSpacing);
    if (!list.length) return null;
    const start = Math.max(0, list.findIndex((t) => trackKeyOf(t) === trackKeyOf(track)));
    const count = Math.min(previewPreset.count, list.length - 1);
    const rows = [] as { track: RadioTrack; from?: RadioTrack; changed: boolean }[];
    for (let step = 1; step <= count; step++) {
      const nextT = list[(start + step) % list.length];
      const nowT = upcoming[step - 1]?.track;
      rows.push({
        track: nextT,
        from: nowT,
        changed: !nowT || trackKeyOf(nowT) !== trackKeyOf(nextT),
      });
    }
    return { relaxesActive, rows, changed: rows.filter((r) => r.changed).length };
  })();

  const nextTrack = upcoming[0]?.track;
  const nextReason = (() => {
    if (!nextTrack) return "";
    if (guardRelaxed)
      return `Repeat guard relaxed for ${relaxRemaining} more track${relaxRemaining === 1 ? "" : "s"} — variety burst, the same ${mixStyle} may repeat back-to-back`;
    if (shuffle) return "Shuffle is on — the next song is drawn at random from the queue";
    if (mixStyle === "shuffle") return "Fully shuffled mix — the playlist order was randomised once";
    if (mixStyle === "genre") {
      return nextTrack.genre && nextTrack.genre !== track?.genre
        ? `Genre rotation — switching to ${nextTrack.genre} (no repeat within ${spacing} track${spacing === 1 ? "" : "s"})`
        : "Genre rotation — spreading each genre across the broadcast";
    }
    return nextTrack.artist && nextTrack.artist !== track?.artist
      ? `Artist rotation — no same artist within ${spacing} track${spacing === 1 ? "" : "s"}`
      : "Artist rotation — last song left in this artist's deck";
  })();

  // Explains, per track card, the exact rule that put it in this slot.
  const constraintFor = (t: RadioTrack, prev?: RadioTrack) => {
    if (guardRelaxed) {
      return `Relaxed guard — the repeat rule is paused for ${relaxRemaining} more track${relaxRemaining === 1 ? "" : "s"}, so this slot was filled purely for variety and the same ${mixStyle} can play back-to-back.`;
    }
    if (shuffle) {
      return "Shuffle is on — this slot was drawn at random from the queue, and no track repeats until the list wraps.";
    }
    if (mixStyle === "shuffle") {
      return "Shuffle rule — the whole rotation was randomised once from the current mix seed, so the order stays the same until you Re-Mix.";
    }
    const gap = `${spacing} track${spacing === 1 ? "" : "s"}`;
    if (mixStyle === "genre") {
      if (prev && t.genre && prev.genre && t.genre !== prev.genre) {
        return `Genre rotation — moved to ${t.genre} because ${prev.genre} just played; no genre repeats within ${gap}.`;
      }
      return `Genre rotation — repeat guard of ${gap} could not be met, so this genre's deck was the only one left.`;
    }
    if (prev && t.artist && prev.artist && t.artist !== prev.artist) {
      return `Artist rotation — ${t.artist} is up because ${prev.artist} just played; no artist repeats within ${gap}.`;
    }
    return `Artist rotation — repeat guard of ${gap} could not be met, so this is the last song left in ${t.artist}'s deck.`;
  };

  // Re-Mix: new deterministic rotation, but the song playing right now keeps
  // playing — we just re-point the index at it in the new order.
  const keepCurrentTrack = () => {
    const keepKey = track ? trackKeyOf(track) : null;
    pendingRestoreRef.current = keepKey ? { trackKey: keepKey, queue: [] } : null;
    orderRef.current = [];
  };

  // Relax the repeat guard for the next few songs (more variety, artists may
  // land back-to-back), then restore the saved guard on its own.
  const relaxGuard = (count: number, rules: RelaxRules = { artist: true, genre: true }, presetId?: string) => {
    keepCurrentTrack();
    setRelaxSize(count);
    setRelaxRules(rules);
    setActivePresetId(presetId ?? null);
    setRelaxRemaining(count);
  };
  const endRelax = () => {
    if (!relaxed) return;
    keepCurrentTrack();
    setActivePresetId(null);
    setRelaxRemaining(0);
  };
  // Save the current burst shape as a reusable preset.
  const savePreset = () => {
    const count = Math.max(1, Math.min(50, Math.round(presetDraft.count) || 1));
    const rules = presetDraft.rules.artist || presetDraft.rules.genre
      ? presetDraft.rules
      : { artist: true, genre: true };
    const preset: RelaxPreset = {
      id: `preset-${Date.now().toString(36)}`,
      name: presetDraft.name.trim().slice(0, 32) || `${count}-Track Burst`,
      count,
      rules,
    };
    setRelaxPresets((list) => [...list, preset].slice(-12));
    setPresetFormOpen(false);
    setPresetDraft({ name: "", count: 5, rules: { artist: true, genre: true } });
  };
  // Export / import presets so they can travel between browsers or people.
  const flashPresetNotice = (msg: string) => {
    setPresetNotice(msg);
    window.setTimeout(() => setPresetNotice(""), 4000);
  };
  const exportPresets = async () => {
    const payload = JSON.stringify(
      { kind: "hybrid-radio-relax-presets", version: 1, presets: relaxPresets },
      null,
      2,
    );
    try {
      const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "hybrid-relax-presets.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
    try {
      await navigator.clipboard?.writeText(payload);
      flashPresetNotice(`Exported ${relaxPresets.length} presets — file saved and copied to clipboard`);
      return;
    } catch {}
    flashPresetNotice(`Exported ${relaxPresets.length} presets`);
  };
  const importPresetsFromText = (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      flashPresetNotice("Import failed — that file is not valid preset JSON");
      return;
    }
    const raw = Array.isArray(parsed) ? parsed : (parsed as any)?.presets;
    const incoming = sanitizeRelaxPresets(raw);
    if (!incoming || incoming.length === 0) {
      flashPresetNotice("Import failed — no valid presets found in that file");
      return;
    }
    let added = 0;
    setRelaxPresets((list) => {
      const merged = [...list];
      for (const preset of incoming) {
        const dupe = merged.some(
          (p) =>
            p.name.toLowerCase() === preset.name.toLowerCase() &&
            p.count === preset.count &&
            p.rules.artist === preset.rules.artist &&
            p.rules.genre === preset.rules.genre,
        );
        if (dupe) continue;
        const id = merged.some((p) => p.id === preset.id)
          ? `preset-${Math.random().toString(36).slice(2, 9)}`
          : preset.id;
        merged.push({ ...preset, id });
        added += 1;
      }
      return merged.slice(-12);
    });
    flashPresetNotice(
      added > 0
        ? `Imported ${added} preset${added === 1 ? "" : "s"}`
        : "Nothing new — those presets are already saved",
    );
  };
  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    importPresetsFromText(await file.text());
  };
  const importFromClipboard = async () => {
    try {
      const text = await navigator.clipboard?.readText();
      if (text) {
        importPresetsFromText(text);
        return;
      }
    } catch {}
    importInputRef.current?.click();
  };

  const deletePreset = (id: string) => {
    setRelaxPresets((list) => list.filter((p) => p.id !== id));
    setActivePresetId((current) => (current === id ? null : current));
  };

  // Count down one song per track change while the relax window is open.
  const relaxIdxRef = useRef(idx);
  useEffect(() => {
    if (relaxIdxRef.current === idx) return;
    relaxIdxRef.current = idx;
    if (!relaxed) return;
    setRelaxRemaining((n) => {
      const next = Math.max(0, n - 1);
      if (next === 0) keepCurrentTrack();
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  const changeSpacing = (value: number) => {
    const next = Math.max(1, Math.min(5, Math.round(value)));
    if (next === spacing) return;
    const keepKey = track ? trackKeyOf(track) : null;
    pendingRestoreRef.current = keepKey ? { trackKey: keepKey, queue: [] } : null;
    orderRef.current = [];
    setSpacing(next);
  };

  const [shareCopied, setShareCopied] = useState(false);
  const shareMix = async () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("mix", mixStyle);
    url.searchParams.set("seed", String(mixSeed));
    url.searchParams.set("gap", String(spacing));
    url.searchParams.set("sh", shuffle ? "1" : "0");
    url.hash = "radio";
    const link = url.toString();
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      window.prompt("Copy this mix link:", link);
    }
    setShareCopied(true);
    window.setTimeout(() => setShareCopied(false), 2000);
  };

  // Stops playback and returns every mix control to its factory defaults.
  const stopPlayback = () => {
    try {
      audioRef.current?.pause();
      playerRef.current?.pauseVideo?.();
    } catch {}
    setPlaying(false);
    setCurrent(0);
  };

  const [clearedSaved, setClearedSaved] = useState(false);

  const resetMix = () => {
    stopPlayback();
    pendingRestoreRef.current = null;
    orderRef.current = [];
    setMixStyle("artist");
    setMixSeed(0);
    setSpacing(1);
    setUpNext(10);
    setShowReasons(true);
    setShuffle(false);
    setIdx(0);
    setConfirmed(false);
  };

  const clearSavedQueue = () => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(RADIO_SETTINGS_KEY);
        window.localStorage.removeItem(RADIO_POSITIONS_KEY);
        window.localStorage.removeItem(RADIO_POSITION_TIMES_KEY);

      } catch {}
      // Drop any shared-mix parameters so a reload really starts clean.
      const url = new URL(window.location.href);
      let touched = false;
      for (const key of ["mix", "seed", "gap", "sh"]) {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key);
          touched = true;
        }
      }
      if (touched) window.history.replaceState({}, "", url.toString());
    }
    resetMix();
    setClearedSaved(true);
    window.setTimeout(() => setClearedSaved(false), 2000);
  };

  const reMix = () => {
    const keepKey = track ? trackKeyOf(track) : null;
    pendingRestoreRef.current = keepKey ? { trackKey: keepKey, queue: [] } : null;
    orderRef.current = [];
    setMixSeed((s) => (s + 1) % 1000);
  };

  const toggleShuffle = () =>
    setShuffle((s) => {
      if (!s) buildOrder(idx);
      return !s;
    });

  const next = () => step(1);
  const prev = () => step(-1);
  advanceRef.current = next;
  // A manual jump is an explicit "resume here" — persist it right away so a
  // reload or another signed-in device picks up the exact spot. Duplicate
  // events for the same spot (slider change+input, replayed effects, a resume
  // re-applied twice) are dropped so playback never stutters.
  const commitSeek = (v: number, kind: SyncEventKind = "seek") => {
    if (!Number.isFinite(v) || v < 0) return;
    const playhead = isAudio
      ? (audioRef.current?.currentTime ?? current)
      : (playerRef.current?.getCurrentTime?.() ?? current);
    if (!shouldSeek(playhead, v)) {
      // Already there — keep the UI honest, but issue no seek and no new stamp.
      setCurrent(v);
      return;
    }
    if (isAudio) {
      if (audioRef.current) audioRef.current.currentTime = v;
    } else {
      playerRef.current?.seekTo?.(v, true);
    }
    setCurrent(v);
    const t = trackRef.current;
    if (t) {
      writePosition(trackKeyOf(t), v, duration, true);
      positionsDirtyRef.current = true;
      logSyncEvent(trackKeyOf(t), kind, v);
      pushPositions.current();
    }
  };


  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    commitSeek(Number(e.target.value));
  };

  const pct = duration ? (current / duration) * 100 : 0;
  const bufferedPct = duration ? Math.min(100, (buffered / duration) * 100) : 0;

  // Group the audit trail by track, newest activity first.
  const historyGroups = useMemo(() => {
    const meta = new Map(tracks.map((t) => [trackKeyOf(t), t]));
    const saved = readPositions();
    const groups = new Map<
      string,
      { key: string; title: string; artist: string; saved: number; events: SyncEvent[] }
    >();
    for (const e of syncHistory) {
      let g = groups.get(e.key);
      if (!g) {
        const t = meta.get(e.key);
        g = {
          key: e.key,
          title: t?.title ?? e.key,
          artist: t?.artist ?? "",
          saved: saved[e.key] ?? 0,
          events: [],
        };
        groups.set(e.key, g);
      }
      if (g.events.length < 6) g.events.push(e);
    }
    return [...groups.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncHistory, tracks]);

  // Latest cross-device resolution per track: when it settled and who won.
  const resolutions = useMemo(() => {
    const meta = new Map(tracks.map((t) => [trackKeyOf(t), t]));
    const seen = new Map<
      string,
      {
        key: string;
        title: string;
        artist: string;
        seconds: number;
        at: number;
        wonAt?: number;
        device: string;
        side: "remote" | "local";
      }
    >();
    for (const e of syncHistory) {
      if (e.kind !== "resolved" || seen.has(e.key)) continue;
      const t = meta.get(e.key);
      seen.set(e.key, {
        key: e.key,
        title: t?.title ?? e.key,
        artist: t?.artist ?? "",
        seconds: e.seconds,
        at: e.at,
        ...(e.wonAt ? { wonAt: e.wonAt } : {}),
        device: e.device ?? (e.winner === "local" ? "This device" : "Another device"),
        side: e.winner ?? (e.device ? "remote" : "local"),
      });
    }
    return [...seen.values()].sort((a, b) => b.at - a.at);
  }, [syncHistory, tracks]);




  // Mobile: show a sticky mini-player only once the full console is off screen.
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const [consoleVisible, setConsoleVisible] = useState(true);
  useEffect(() => {
    const el = consoleRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      ([entry]) => setConsoleVisible(entry?.isIntersecting ?? true),
      { rootMargin: "-72px 0px 0px 0px", threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const showMini = confirmed && !consoleVisible && Boolean(track);

  // Global shortcuts: number keys 1-9 fire the matching saved Relax preset
  // instantly during playback, 0 restores the saved guard.
  const presetHotkeyRef = useRef({ presets: relaxPresets, relaxGuard, endRelax, relaxed });
  presetHotkeyRef.current = { presets: relaxPresets, relaxGuard, endRelax, relaxed };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || el?.isContentEditable) return;
      if (!/^[0-9]$/.test(e.key)) return;
      const { presets, relaxGuard: apply, endRelax: stop, relaxed: isRelaxed } = presetHotkeyRef.current;
      if (e.key === "0") {
        if (!isRelaxed) return;
        e.preventDefault();
        stop();
        flashPresetNotice("Repeat guard restored");
        return;
      }
      const preset = presets[Number(e.key) - 1];
      if (!preset) return;
      e.preventDefault();
      apply(preset.count, preset.rules, preset.id);
      flashPresetNotice(`${preset.name} burst applied — ${preset.count} tracks`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keyboard shortcuts inside the console: space/k play-pause, arrows seek or
  // change track, s shuffle. Ignored while typing in a field or on a control
  // that already handles the key (buttons, sliders).
  const onConsoleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || el?.isContentEditable) return;
    const onButton = tag === "button" || tag === "a";
    if (e.key === " " || e.key.toLowerCase() === "k") {
      if (onButton && e.key === " ") return;
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (e.shiftKey) next();
      else commitSeek(Math.min(duration, current + 10));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (e.shiftKey) prev();
      else commitSeek(Math.max(0, current - 10));
    } else if (e.key.toLowerCase() === "s" && !onButton) {
      e.preventDefault();
      toggleShuffle();
    }
  };

  return (
    <>
    <section
      ref={consoleRef}
      data-radio-console
      aria-label="Hybrid AI Radio player"
      onKeyDown={onConsoleKeyDown}
      className="relative overflow-hidden rounded-xl studio-glass p-5 text-start"
    >
      <p className="sr-only">
        Keyboard shortcuts: space or K plays and pauses, left and right arrows seek ten seconds,
        shift with left or right arrow changes track, S toggles shuffle. Number keys 1 through 9
        apply the matching saved Relax preset, and 0 restores the repeat guard.
      </p>
      <p aria-live="polite" className="sr-only">
        {track
          ? buffering
            ? `Buffering: ${track.title} by ${track.artist}`
            : `${playing ? "Playing" : "Paused"}: ${track.title} by ${track.artist}`
          : "No track loaded"}
      </p>

      {/* Shared catalog <audio> is owned by catalog-player (bound via audioRef). */}
      {/* hidden YT mount */}
      <div className="pointer-events-none absolute top-0 start-0 h-0 w-0 overflow-hidden opacity-0">
        <div ref={mountRef} />
      </div>


      {/* Rotation preview — shown until the listener confirms the mix */}
      {!confirmed && (
        <div
          data-testid="radio-mix-preview"
          className="mb-5 rounded-xl border border-primary/40 bg-primary/[0.06] p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-primary">
                Review Your Rotation
              </div>
              <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                {mixStyle === "shuffle" ? "Fully shuffled" : `Balanced by ${mixStyle}`}
                {mixStyle !== "shuffle" ? ` · repeat guard ${spacing}` : ""} · {tracks.length} tracks
              </div>
            </div>
            <button
              type="button"
              onClick={confirmPlay}
              className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white transition hover:brightness-110"
            >
              <Play size={13} /> Confirm Play
            </button>
          </div>
          <ol className="mt-3 max-h-48 space-y-1 overflow-y-auto pe-1">
            {tracks.slice(0, 12).map((t, i) => (
              <li
                key={`${t.id}-preview-${i}`}
                tabIndex={0}
                title={constraintFor(t, tracks[i - 1])}
                aria-label={`${t.title} by ${t.artist}. ${constraintFor(t, tracks[i - 1])}`}
                className="group relative grid grid-cols-[1.25rem_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5 rounded outline-none focus-visible:ring-1 focus-visible:ring-primary sm:flex sm:items-center">
                <span className="w-5 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span className="rwb-flame rwb-flame-deep min-w-0 flex-1 truncate text-[12px] font-semibold text-white/90">{t.title}</span>
                <span className="col-start-2 min-w-0 truncate font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground sm:shrink-0">
                  {t.artist}
                </span>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute bottom-full start-0 z-20 mb-1 hidden w-64 rounded-md border border-primary/50 bg-ink/95 px-2.5 py-1.5 text-[10px] leading-snug text-white/90 shadow-[0_0_20px_-6px_rgba(225,29,46,0.9)] group-hover:block group-focus-visible:block"
                >
                  {constraintFor(t, tracks[i - 1])}
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-2 font-mono text-[9px] tracking-wide text-muted-foreground">
            Change Mix Style, Repeat Guard or Re-Mix below, then confirm to start playback.
          </p>
        </div>
      )}

      {/* Now playing */}
      <div className="flex flex-wrap items-center gap-3 sm:gap-4">
        {track?.cover && (
          <CoverImage
            key={`${track.id}-cover`}
            src={track.cover}
            alt={`${track.title} album artwork`}
            priority
            sizes="64px"
            width={64}
            height={64}
            className="h-16 w-16 shrink-0 rounded-md border border-border-strong object-cover shadow-[0_0_24px_-8px_rgba(225,29,46,0.9)] animate-in fade-in zoom-in-95 duration-500 ease-out motion-reduce:animate-none"
            onError={() => {
              console.warn("[radio] cover failed:", { id: track.id, cover_url: track.cover });
            }}
          />
        )}
        <div
          key={`${track?.id ?? "empty"}-meta`}
          className="min-w-0 flex-1 basis-[9rem] animate-in fade-in slide-in-from-bottom-2 duration-400 ease-out motion-reduce:animate-none"
        >

          {metaFields.title && (
            <div
              data-testid="radio-track-title"
              className="rwb-flame rwb-flame-deep truncate font-display text-sm font-semibold text-white sm:text-base"
            >
              {track?.title ?? "—"}
            </div>
          )}
          {(metaFields.artist || buffering) && (
            <div
              data-testid="radio-track-artist"
              className="flex items-center gap-2 truncate font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground"
            >
              {metaFields.artist && <span className="truncate">{track?.artist ?? ""}</span>}
              {buffering && (
                <span
                  data-testid="radio-buffering"
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/50 bg-primary/10 px-2 py-0.5 text-[9px] tracking-[0.18em] text-primary"
                >
                  <Loader2 size={9} className="animate-spin" />
                  Buffering
                </span>
              )}
            </div>
          )}
          {minimal &&
            ((metaFields.album && track?.album) ||
              (metaFields.genre && track?.genre) ||
              (metaFields.division && track?.division) ||
              (metaFields.credits && track?.credits)) && (
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                aria-expanded={showDetails}
                data-testid="radio-details-toggle"
                className="mt-1 rounded-full border border-border-strong bg-white/5 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-white/60 transition hover:border-primary hover:text-primary"
              >
                {showDetails ? "Hide details" : "Details"}
              </button>
            )}
          {(!minimal || showDetails) && (
            <>
              {((metaFields.album && track?.album) ||
                (metaFields.genre && track?.genre) ||
                (metaFields.division && track?.division)) && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {metaFields.album && track?.album && (
                    <span className="max-w-full truncate rounded-full border border-border-strong bg-white/5 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-white/70">
                      {track.album}
                      {track.trackNumber
                        ? ` · ${track.trackNumber}/${track.trackTotal ?? track.trackNumber}`
                        : ""}
                    </span>
                  )}
                  {metaFields.genre && track?.genre && (
                    <span className="rounded-full border border-primary/50 bg-primary/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-primary">
                      {track.genre}
                    </span>
                  )}
                  {metaFields.division && track?.division && (
                    <span className="max-w-full truncate rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-accent">
                      {divisionNames[track.division]}
                    </span>
                  )}
                </div>
              )}
              {metaFields.credits && track?.credits && (
                <div className="mt-1 truncate font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
                  {track.credits}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-nowrap items-center gap-2 max-sm:basis-full max-sm:justify-center">
          <button
            type="button"
            onClick={prev}
            aria-label="Previous"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-strong bg-white/5 text-white/80 transition hover:border-primary hover:text-primary"
          >
            <SkipBack size={18} />
          </button>
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? "Pause" : "Play"}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary bg-primary text-white shadow-[0_0_24px_-6px_rgba(225,29,46,0.9)] transition hover:brightness-110"
          >
            {buffering ? (
              <Loader2 size={18} className="animate-spin" />
            ) : playing ? (
              <Pause size={18} fill="currentColor" />
            ) : (
              <Play size={18} fill="currentColor" className="translate-x-0.5" />
            )}
          </button>
          <button
            type="button"
            onClick={next}
            aria-label="Next"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-strong bg-white/5 text-white/80 transition hover:border-primary hover:text-primary"
          >
            <SkipForward size={18} />
          </button>
          <button
            type="button"
            onClick={toggleShuffle}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            title={shuffle ? "Shuffle on" : "Shuffle off"}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition ${
              shuffle
                ? "border-primary bg-primary/20 text-primary shadow-[0_0_18px_-6px_rgba(225,29,46,0.9)]"
                : "border-border-strong bg-white/5 text-white/80 hover:border-primary hover:text-primary"
            }`}
          >
            <Shuffle size={18} />
          </button>
        </div>

      </div>

      {/* Progress */}
      <div className="mt-4 flex items-center gap-3">
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{fmt(current)}</span>
        <div className="group relative flex-1 py-1">
          <WaveSeek
            seed={track?.id ?? "idle"}
            pct={pct}
            bufferedPct={bufferedPct}
            playing={playing && !buffering}
          />
          {/* seek marker */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-1 w-px -translate-x-1/2 bg-white/70 opacity-0 shadow-[0_0_10px_rgba(225,29,46,0.9)] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            style={{ left: `${pct}%` }}
          />

          <input
            type="range"
            min={0}
            max={duration || 0}
            step={1}
            value={current}
            onChange={seek}
            aria-label="Seek within the current track"
            aria-valuetext={`${fmt(current)} of ${fmt(duration)}${buffering ? ", buffering" : ""}`}
            disabled={!duration}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          />
        </div>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{fmt(duration)}</span>
      </div>

      {/* One row of panel toggles keeps the console calm by default */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-3">
        {PANELS.map((p) => {
          const active = openPanel === p.value;
          return (
            <button
              key={p.value}
              type="button"
              onClick={() => setOpenPanel(active ? "none" : p.value)}
              aria-expanded={active}
              className={`radio-label-blue inline-flex min-h-11 items-center rounded-full border px-4 py-1 font-mono text-[9px] uppercase tracking-[0.18em] transition sm:min-h-9 ${
                active
                  ? "border-[#2563eb] bg-[#2563eb]/15"
                  : "border-[#2563eb]/40 bg-white/5 hover:border-[#2563eb]"
              }`}

            >
              {p.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setMinimal((v) => {
              const nextVal = !v;
              if (nextVal) {
                setOpenPanel("none");
                setShowDetails(false);
              }
              return nextVal;
            });
          }}
          aria-pressed={minimal}
          data-testid="radio-minimal-toggle"
          title={minimal ? "Minimal mode on — badges and extra metadata hidden" : "Collapse badges and extra metadata"}
          className={`radio-label-blue inline-flex min-h-11 items-center rounded-full border px-4 py-1 font-mono text-[9px] uppercase tracking-[0.18em] transition sm:ms-auto sm:min-h-9 ${
            minimal
              ? "border-[#2563eb] bg-[#2563eb]/15"
              : "border-[#2563eb]/40 bg-white/5 hover:border-[#2563eb]"
          }`}

        >
          Minimal
        </button>
      </div>

      {/* Display settings — choose which metadata shows while playing */}
      {openPanel === "display" && (
        <div className="mt-4 border-t border-white/5 pt-4" data-testid="radio-display-panel">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="radio-label-blue min-w-0 font-mono text-[10px] uppercase tracking-[0.24em]">
              Now Playing Metadata
            </div>
            <button
              type="button"
              onClick={() => setMetaFields(DEFAULT_META_FIELDS)}
              className="shrink-0 rounded-full border border-border-strong bg-white/5 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-white/60 transition hover:border-primary hover:text-primary"
            >
              Show all
            </button>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {META_FIELDS.map((f) => {
              const on = metaFields[f.value];
              return (
                <button
                  key={f.value}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  title={f.hint}
                  data-testid={`radio-meta-${f.value}`}
                  onClick={() => setMetaFields((prev) => ({ ...prev, [f.value]: !prev[f.value] }))}
                  className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-start transition ${
                    on
                      ? "border-primary/60 bg-primary/10"
                      : "border-border-strong bg-white/5 hover:border-primary/50"
                  }`}
                >
                  <span className="min-w-0">
                    <span
                      className={`block truncate font-mono text-[10px] uppercase tracking-[0.18em] ${
                        on ? "text-primary" : "text-white/60"
                      }`}
                    >
                      {f.label}
                    </span>
                    <span className="block truncate font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                      {f.hint}
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className={`flex h-4 w-7 shrink-0 items-center rounded-full border px-0.5 transition ${
                      on ? "border-primary bg-primary/30" : "border-border-strong bg-white/10"
                    }`}
                  >
                    <span
                      className={`h-3 w-3 rounded-full transition ${
                        on ? "translate-x-3 bg-primary" : "translate-x-0 bg-white/40"
                      }`}
                    />
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
            Saved with your mix settings and synced to signed-in devices.
          </p>
        </div>
      )}



      {/* Mix controls */}
      {openPanel === "mix" && (
      <>
      {/* Secondary mix actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-4">

        <button
          type="button"
          onClick={reMix}
          aria-label="Re-Mix playlist"
          title="Re-Mix — build a fresh rotation without interrupting the current song"
          className="flex h-8 items-center gap-1.5 rounded-full border border-border-strong bg-white/5 px-3 text-white/80 transition hover:border-primary hover:text-primary"
        >
          <RefreshCw size={13} />
          <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.18em]">Re-Mix</span>
        </button>
        <button
          type="button"
          onClick={shareMix}
          aria-label="Copy shareable mix link"
          title="Copy a link that loads this exact mix for someone else"
          className={`flex h-8 items-center gap-1.5 rounded-full border px-3 transition ${
            shareCopied
              ? "border-primary bg-primary/20 text-primary"
              : "border-border-strong bg-white/5 text-white/80 hover:border-primary hover:text-primary"
          }`}
        >
          {shareCopied ? <Check size={13} /> : <Link2 size={13} />}
          <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.18em]">
            {shareCopied ? "Copied" : "Share"}
          </span>
        </button>
        {accountEmail ? (
          <SyncBadge
            accountEmail={accountEmail}
            syncState={syncState}
            resolveState={resolveState}
            conflictNotice={conflictNotice}
            lastResolvedAt={lastResolvedAt}
            nowTick={nowTick}
            retrying={retrying}
            onRetry={() => retryResolve.current()}
          />

        ) : (




          <a
            href="/auth"
            className="flex h-8 items-center gap-1.5 rounded-full border border-border-strong bg-white/5 px-3 text-white/80 transition hover:border-primary hover:text-primary"
            title="Sign in to sync your mix across devices"
          >
            <LogIn size={13} />
            <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.18em]">Sync</span>
          </a>
        )}
        <span className="flex w-full flex-wrap items-center gap-2 sm:ms-auto sm:w-auto sm:justify-end">
          <button
            type="button"
            onClick={resetMix}
            aria-label="Reset mix settings to defaults"
            title="Reset mix style, seed, spacing and shuffle back to defaults"
            className="flex h-8 items-center gap-1.5 rounded-full border border-border-strong bg-white/5 px-3 text-white/60 transition hover:border-primary hover:text-primary"
          >
            <RotateCcw size={13} />
            <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.18em]">Reset</span>
          </button>
          <button
            type="button"
            onClick={clearSavedQueue}
            aria-label="Clear the saved queue and mix settings"
            title="Forget the saved mix mode, queue order and last played track"
            className={`flex h-8 items-center gap-1.5 rounded-full border px-3 transition ${
              clearedSaved
                ? "border-primary bg-primary/20 text-primary"
                : "border-border-strong bg-white/5 text-white/60 hover:border-primary hover:text-primary"
            }`}
          >
            {clearedSaved ? <Check size={13} /> : <Trash2 size={13} />}
            <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.18em]">
              {clearedSaved ? "Cleared" : "Clear Queue"}
            </span>
          </button>
        </span>
      </div>


      {/* Mix style */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
          Mix Style
        </span>
        <div
          role="radiogroup"
          aria-label="Mix style"
          className="flex flex-wrap gap-1 rounded-full border border-border-strong bg-white/5 p-1"
        >
          {MIX_STYLES.map((option) => {
            const active = mixStyle === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                title={option.hint}
                onClick={() => selectMixStyle(option.value)}
                className={`rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition ${
                  active
                    ? "bg-primary/20 text-primary shadow-[0_0_18px_-6px_rgba(225,29,46,0.9)]"
                    : "text-white/70 hover:text-primary"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Repeat spacing */}
      {mixStyle !== "shuffle" && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label
            htmlFor="radio-spacing"
            className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground"
          >
            Repeat Guard
          </label>
          <input
            id="radio-spacing"
            type="range"
            min={1}
            max={5}
            step={1}
            value={spacing}
            onChange={(e) => changeSpacing(Number(e.target.value))}
            aria-valuetext={`No same ${mixStyle} within ${spacing} track${spacing === 1 ? "" : "s"}`}
            className="h-1.5 w-36 cursor-pointer appearance-none rounded-full bg-white/10 accent-primary"
          />
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/70">
            {relaxed
              ? guardRelaxed
                ? `Guard relaxed for ${relaxRemaining} more track${relaxRemaining === 1 ? "" : "s"}`
                : `Burst active (${relaxRemaining} left) — this guard is not relaxed`
              : `No same ${mixStyle} within ${spacing} track${spacing === 1 ? "" : "s"}`}
          </span>
          <div
            data-testid="radio-relax-guard"
            className="flex items-center gap-2 rounded-full border border-border-strong bg-white/[0.04] px-2 py-1"
          >
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
              Relax
            </span>
            {relaxed ? (
              <button
                type="button"
                onClick={endRelax}
                aria-label={`Restore the repeat guard now, ${relaxRemaining} relaxed tracks left`}
                title="Restore the saved repeat guard now"
                className="rounded-full bg-primary px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-white transition hover:brightness-110"
              >
                {relaxRemaining} left · Restore
              </button>
            ) : (
              [3, 5, 10].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => relaxGuard(n)}
                  aria-label={`Relax the repeat guard for the next ${n} tracks`}
                  aria-pressed={relaxSize === n}
                  title={`Allow same-${mixStyle} back-to-back for the next ${n} tracks, then restore the guard`}
                  className={`rounded-full px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] transition hover:bg-primary/20 hover:text-white ${
                    relaxSize === n ? "bg-white/10 text-white" : "text-muted-foreground"
                  }`}
                >
                  {n}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Saved relax presets */}
      {mixStyle !== "shuffle" && (
        <div
          data-testid="radio-relax-presets"
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            Presets
          </span>
          {relaxPresets.length === 0 && (
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
              None saved
            </span>
          )}
          {relaxPresets.map((preset) => {
            const active = activePresetId === preset.id && relaxed;
            const ruleLabel = preset.rules.artist && preset.rules.genre
              ? "artist + genre"
              : preset.rules.artist
                ? "artist"
                : "genre";
            const hotkeyIndex = relaxPresets.indexOf(preset) + 1;
            const hotkey = hotkeyIndex <= 9 ? String(hotkeyIndex) : null;
            return (
              <span
                key={preset.id}
                className={`flex max-w-full items-center gap-1 rounded-full border px-1 py-0.5 transition ${
                  active
                    ? "border-primary bg-primary/20"
                    : "border-border-strong bg-white/[0.04]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => relaxGuard(preset.count, preset.rules, preset.id)}
                  title={`Relax the ${ruleLabel} guard for the next ${preset.count} tracks${hotkey ? ` — press ${hotkey}` : ""}`}
                  aria-label={`Apply preset ${preset.name}: relax the ${ruleLabel} guard for the next ${preset.count} tracks${hotkey ? `, keyboard shortcut ${hotkey}` : ""}`}
                  aria-pressed={active}
                  className={`min-w-0 truncate rounded-full px-2 py-0.5 text-start font-mono text-[9px] uppercase tracking-[0.16em] transition hover:text-primary ${
                    active ? "text-primary" : "text-white/80"
                  }`}
                >
                  {hotkey && (
                    <span className="me-1 rounded border border-border-strong bg-ink/50 px-1 text-[8px] text-white/60">
                      {hotkey}
                    </span>
                  )}
                  {preset.name} · {preset.count} · {ruleLabel}
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewPresetId((id) => (id === preset.id ? null : preset.id))}
                  aria-label={`Preview which upcoming tracks preset ${preset.name} would change`}
                  aria-pressed={previewPresetId === preset.id}
                  title="Preview the rotation this preset would create"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition hover:bg-primary/20 hover:text-primary ${
                    previewPresetId === preset.id ? "text-primary" : "text-muted-foreground"
                  }`}
                >
                  <Eye size={10} />
                </button>
                <button
                  type="button"
                  onClick={() => deletePreset(preset.id)}
                  aria-label={`Delete preset ${preset.name}`}
                  title="Delete this preset"
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-primary/20 hover:text-primary"
                >
                  <X size={10} />
                </button>
              </span>
            );
          })}
          {previewPreset && (
            <div
              data-testid="radio-relax-preview"
              className="w-full rounded-lg border border-primary/40 bg-ink/50 p-3 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
                  Preview · {previewPreset.name}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      relaxGuard(previewPreset.count, previewPreset.rules, previewPreset.id);
                      setPreviewPresetId(null);
                    }}
                    className="rounded-full border border-primary bg-primary/20 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.16em] text-primary transition hover:bg-primary/30"
                  >
                    Apply Burst
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewPresetId(null)}
                    aria-label="Close the preset preview"
                    className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition hover:bg-primary/20 hover:text-primary"
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>
              {!relaxPreview ? (
                <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                  No rotation to compare yet
                </p>
              ) : (
                <>
                  <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                    {relaxPreview.relaxesActive
                      ? `${relaxPreview.changed} of the next ${relaxPreview.rows.length} tracks would change`
                      : `Does not relax the ${mixStyle} guard — rotation stays the same`}
                    {shuffle ? " · shuffle is on, live order may still vary" : ""}
                  </p>
                  <ol className="mt-2 max-h-48 space-y-1 overflow-y-auto pe-1">
                    {relaxPreview.rows.map((row, i) => (
                      <li
                        key={`${row.track.id}-${i}`}
                        className={`flex items-start gap-2 rounded-md border px-2 py-1 ${
                          row.changed
                            ? "border-primary/50 bg-primary/10"
                            : "border-border-strong bg-white/[0.03]"
                        }`}
                      >
                        <span className="mt-0.5 font-mono text-[9px] tabular-nums text-muted-foreground">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="rwb-flame rwb-flame-deep block truncate text-[11px] font-semibold">
                            {row.track.title}
                            <span className="text-muted-foreground"> — {row.track.artist}</span>
                          </span>
                          {row.changed && row.from && (
                            <span className="block truncate font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                              was {row.from.title} — {row.from.artist}
                            </span>
                          )}
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.16em] ${
                            row.changed ? "bg-primary/25 text-primary" : "text-muted-foreground"
                          }`}
                        >
                          {row.changed ? "Changes" : "Same"}
                        </span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={exportPresets}
            disabled={relaxPresets.length === 0}
            title="Download your presets as JSON (also copied to your clipboard)"
            aria-label="Export relax presets to a JSON file"
            className="flex items-center gap-1 rounded-full border border-border-strong bg-white/5 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-white/70 transition hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download size={11} />
            Export
          </button>
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            onDoubleClick={importFromClipboard}
            title="Load presets from a JSON file (double-click to paste from clipboard)"
            aria-label="Import relax presets from a JSON file"
            className="flex items-center gap-1 rounded-full border border-border-strong bg-white/5 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-white/70 transition hover:border-primary hover:text-primary"
          >
            <Upload size={11} />
            Import
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            onChange={onImportFile}
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
          />
          {presetNotice && (
            <span
              role="status"
              className="font-mono text-[9px] uppercase tracking-[0.14em] text-primary"
            >
              {presetNotice}
            </span>
          )}
          <button
            type="button"
            onClick={() => setPresetFormOpen((v) => !v)}
            aria-expanded={presetFormOpen}
            className="flex items-center gap-1 rounded-full border border-border-strong bg-white/5 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-white/70 transition hover:border-primary hover:text-primary"
          >
            <Plus size={11} />
            New Preset
          </button>

          {presetFormOpen && (
            <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-ink/50 px-3 py-2">
              <input
                value={presetDraft.name}
                onChange={(e) => setPresetDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Preset name"
                aria-label="Preset name"
                maxLength={32}
                className="h-8 w-40 rounded-md border border-border-strong bg-white/5 px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white outline-none placeholder:text-muted-foreground focus:border-primary"
              />
              <label className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                Tracks
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={presetDraft.count}
                  onChange={(e) => setPresetDraft((d) => ({ ...d, count: Number(e.target.value) }))}
                  aria-label="Tracks in this burst"
                  className="h-8 w-16 rounded-md border border-border-strong bg-white/5 px-2 font-mono text-[10px] text-white outline-none focus:border-primary"
                />
              </label>
              {(["artist", "genre"] as const).map((rule) => (
                <label
                  key={rule}
                  className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-white/70"
                >
                  <input
                    type="checkbox"
                    checked={presetDraft.rules[rule]}
                    onChange={(e) =>
                      setPresetDraft((d) => ({ ...d, rules: { ...d.rules, [rule]: e.target.checked } }))
                    }
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  Relax {rule}
                </label>
              ))}
              <button
                type="button"
                onClick={savePreset}
                aria-label="Save this relax preset"
                className="ms-auto rounded-full bg-primary px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-white transition hover:brightness-110"
              >
                Save Preset
              </button>
              <button
                type="button"
                onClick={() => setPresetFormOpen(false)}
                aria-label="Cancel creating a relax preset"
                className="rounded-full border border-border-strong px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-white/60 transition hover:border-primary hover:text-primary"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}


      </>
      )}


      {/* Up next — queue and explainer live together behind one toggle */}
      {openPanel === "queue" && (
      <>
      {nextTrack && (
        <div
          data-testid="radio-next-reason"
          className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border-strong bg-white/5 px-3 py-2"
        >
          <span className="radio-label-blue font-mono text-[9px] uppercase tracking-[0.24em]">Up Next</span>
          <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-white/80">
            <span className="rwb-flame rwb-flame-deep font-semibold">{nextTrack.title}</span> — {nextTrack.artist}
          </span>
          <span className="font-mono text-[9px] normal-case tracking-normal text-muted-foreground">
            {nextReason}
          </span>
        </div>
      )}

      {upcoming.length > 0 && (

        <div
          data-testid="radio-up-next-queue"
          className="mt-3 rounded-xl border border-border-strong bg-white/[0.03] p-3"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="radio-label-blue min-w-0 font-mono text-[10px] uppercase tracking-[0.24em]">
              Up Next Queue
            </div>
            <div className="min-w-0 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
              {mixStyle === "shuffle" ? "Shuffled" : `By ${mixStyle}`} · next {upcoming.length}
            </div>
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-1">

            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
              Window
            </span>
            {UP_NEXT_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setUpNext(n)}
                aria-pressed={upNext === n}
                title={`Show the next ${n} tracks (saved for next time)`}
                className={`rounded-md border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] transition ${
                  upNext === n
                    ? "border-primary/60 bg-primary/15 text-primary"
                    : "border-border-strong text-muted-foreground hover:text-foreground"
                }`}
              >
                {n}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowReasons((v) => !v)}
              aria-pressed={showReasons}
              title="Show the rotation rule under every queued track"
              className={`ms-auto rounded-md border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] transition ${
                showReasons
                  ? "border-primary/60 bg-primary/15 text-primary"
                  : "border-border-strong text-muted-foreground hover:text-foreground"
              }`}
            >
              Why
            </button>
          </div>
          <ol className={`space-y-1 overflow-y-auto pe-1 ${showReasons ? "max-h-80" : "max-h-56"}`}>
            {upcoming.map((entry, i) => (
              <li key={`${entry.track.id}-${entry.index}`} className="group relative">
                <button
                  type="button"
                  onClick={() => setIdx(entry.index)}
                  title={constraintFor(entry.track, i === 0 ? track : upcoming[i - 1]?.track)}
                  aria-label={`Play ${entry.track.title} by ${entry.track.artist}. ${constraintFor(
                    entry.track,
                    i === 0 ? track : upcoming[i - 1]?.track,
                  )}`}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start transition hover:bg-primary/10"
                >
                  <span className="w-5 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="rwb-flame rwb-flame-deep block truncate text-[12px] font-semibold">{entry.track.title}</span>
                    <span className="block truncate font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                      {entry.track.artist}
                      {entry.track.genre ? ` · ${entry.track.genre}` : ""}
                    </span>
                  </span>
                </button>
                {showReasons && (
                  <p
                    data-testid="queue-reason"
                    className="ms-7 me-2 border-s border-primary/40 ps-2 text-[10px] leading-snug text-muted-foreground"
                  >
                    {constraintFor(entry.track, i === 0 ? track : upcoming[i - 1]?.track)}
                  </p>
                )}
                <span
                  role="tooltip"
                  className={`pointer-events-none absolute bottom-full start-2 z-20 mb-1 hidden w-64 rounded-md border border-primary/50 bg-ink/95 px-2.5 py-1.5 text-[10px] leading-snug text-white/90 shadow-[0_0_20px_-6px_rgba(225,29,46,0.9)] ${
                    showReasons ? "" : "group-hover:block group-focus-within:block"
                  }`}
                >
                  {constraintFor(entry.track, i === 0 ? track : upcoming[i - 1]?.track)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      </>
      )}


      {/* Saved-timestamp prompt: confirm the resume point or start over. */}
      {resumePrompt && track && trackKeyOf(track) === resumePrompt.key && (
        <div
          role="status"
          className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/85">
            Saved spot on this track
          </span>
          <button
            type="button"
            onClick={() => {
              commitSeek(resumePrompt.seconds, "resume");
              setResumePrompt(null);
              if (!playing) toggle();
            }}
            aria-label={`Resume this track from ${fmt(resumePrompt.seconds)}`}
            className="rounded-full bg-primary px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white transition hover:brightness-110"
          >
            Resume from {fmt(resumePrompt.seconds)}
          </button>
          <button
            type="button"
            onClick={() => {
              commitSeek(0);
              setResumePrompt(null);
            }}
            aria-label="Start this track from the beginning"
            className="rounded-full border border-border-strong px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/75 transition hover:border-primary hover:text-primary"
          >
            Start over
          </button>
          <button
            type="button"
            onClick={() => setResumePrompt(null)}
            aria-label="Dismiss the resume prompt"
            className="ms-auto font-mono text-[10px] uppercase tracking-[0.16em] text-white/50 transition hover:text-primary"
          >
            Dismiss
          </button>
        </div>
      )}



      {/* Track list */}
      {openPanel === "tracks" && (
      <div className="mt-5 border-t border-border-strong pt-4">

        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="radio-label-blue min-w-0 font-mono text-[10px] uppercase tracking-[0.24em]">Tracklist</div>
          <div className="min-w-0 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            {tracks.length} Tracks
          </div>
        </div>

        {/* Artist Tokens — $1 each, one token per track download */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-strong bg-ink/30 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {artistTokens.signedIn
              ? `${artistTokens.balance ?? "—"} Artist Token${artistTokens.balance === 1 ? "" : "s"} · $1 = 1 download`
              : "Artist Tokens — $1 per track download"}
          </span>
          <button
            type="button"
            onClick={() => artistTokens.setStoreOpen(true)}
            className="rounded-full border border-primary/60 bg-primary/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-primary transition hover:bg-primary/20"
          >
            Buy Artist Tokens
          </button>
        </div>
        {artistTokens.notice ? (
          <p role="status" className="mb-2 text-[11px] text-muted-foreground">
            {artistTokens.notice}
          </p>
        ) : null}

        <ul className="max-h-64 space-y-1 overflow-y-auto pe-1">
          {tracks.map((t, i) => {
            const active = i === idx;
            const owned = artistTokens.unlocked.has(t.id);
            const busy = artistTokens.busyTrack === t.id;
            return (
              <li
                key={t.id}
                className={`flex items-center gap-1 rounded-md border transition ${
                  active
                    ? "border-primary/70 bg-primary/10 shadow-[0_0_20px_-8px_rgba(225,29,46,0.9)]"
                    : "border-transparent hover:border-primary/40 hover:bg-white/[0.03]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setIdx(i)}
                  aria-label={`Play track ${i + 1}, ${t.title} by ${t.artist}`}
                  aria-current={active ? "true" : undefined}
                  className="group flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-start sm:gap-3 sm:px-3"
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] ${
                      active
                        ? "border-primary bg-primary text-white"
                        : "border-border-strong bg-ink/40 text-muted-foreground group-hover:border-primary group-hover:text-primary"
                    }`}
                  >
                    {active && playing ? <Pause size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" className="translate-x-[1px]" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="rwb-flame rwb-flame-deep block truncate text-sm font-semibold">
                      {t.title}
                    </span>
                    <span className="block truncate font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      {t.artist}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void artistTokens.download(t.id)}
                  aria-label={
                    owned
                      ? `Download ${t.title} by ${t.artist} — already unlocked`
                      : `Download ${t.title} by ${t.artist} for 1 Artist Token`
                  }
                  title={owned ? "Unlocked — download again free" : "1 Artist Token ($1)"}
                  className={`me-2 flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 font-mono text-[10px] uppercase tracking-[0.14em] transition disabled:opacity-50 ${
                    owned
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border-strong text-muted-foreground hover:border-primary hover:text-primary"
                  }`}
                >
                  {busy ? (
                    <Loader2 size={12} className="animate-spin" aria-hidden />
                  ) : (
                    <Download size={12} aria-hidden />
                  )}
                  <span className="hidden sm:inline">{owned ? "Saved" : "$1"}</span>
                </button>
              </li>
            );
          })}
        </ul>

      </div>
      )}

      {/* Sync history — per track, the actions that set each resume point */}
      {openPanel === "history" && (
        <SyncHistoryPanel
          failures={syncFailures}
          retries={retryLog}
          resolutions={resolutions}
          groups={historyGroups}
          hasHistory={syncHistory.length > 0}
          onRetry={() => retryResolve.current()}
          onClear={() => {
            try {
              window.localStorage.removeItem(RADIO_HISTORY_KEY);
            } catch {}
            setSyncHistory([]);
          }}
        />
      )}

      <ArtistTokenStore tokens={artistTokens} />

    </section>


    {/* Sticky mobile mini-player */}
    {showMini && (
      <div
        data-testid="radio-mini-player"
        data-radio-console
        role="region"
        aria-label="Radio mini player"
        className="fixed inset-x-0 bottom-[var(--site-dock-height)] z-40 border-t border-border bg-white pb-[env(safe-area-inset-bottom)] sm:hidden lg:bottom-0"
      >
        <div className="relative h-0.5 w-full bg-slate-200">
          <div className="absolute inset-y-0 start-0 bg-slate-300" style={{ width: `${bufferedPct}%` }} />
          <div
            className={`relative h-full bg-primary ${buffering ? "animate-pulse" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2">
          <button
            type="button"
            onClick={() => consoleRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
            aria-label="Open the full radio console"
            className="flex min-w-0 items-center gap-2 text-start"
          >
            {track?.cover && (
              <CoverImage
                key={`${track.id}-mini-cover`}
                src={track.cover}
                alt=""
                sizes="36px"
                width={36}
                height={36}
                className="h-9 w-9 shrink-0 rounded border border-border-strong object-cover animate-in fade-in zoom-in-95 duration-400 ease-out motion-reduce:animate-none"
              />
            )}
            <span
              key={`${track?.id ?? "empty"}-mini-meta`}
              className="min-w-0 animate-in fade-in slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none"
            >
              <span className="rwb-flame rwb-flame-deep block truncate text-[12px] font-semibold">
                {track?.title ?? "—"}
              </span>
              <span className="block truncate font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                {track?.artist ?? ""}
              </span>
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={prev}
              aria-label="Previous"
              className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-white text-foreground"
            >
              <SkipBack size={14} />
            </button>
            <button
              type="button"
              onClick={toggle}
              aria-label={playing ? "Pause" : "Play"}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-primary bg-primary text-white shadow-[0_0_20px_-6px_rgba(225,29,46,0.9)]"
            >
              {buffering ? (
                <Loader2 size={16} className="animate-spin" />
              ) : playing ? (
                <Pause size={16} fill="currentColor" />
              ) : (
                <Play size={16} fill="currentColor" className="translate-x-[1px]" />
              )}
            </button>
            <button
              type="button"
              onClick={next}
              aria-label="Next"
              className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-white text-foreground"
            >
              <SkipForward size={14} />
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );

}

export default RadioPlayer;
