/**
 * Static Charge / Discharge — session residue control for public multi-tenant use.
 *
 * Charge: auth tokens, studio/vault caches, pending jobs, and polling residue that
 * accumulate in browser storage while a user is signed in.
 *
 * Discharge: controlled bleed-off on logout, account switch, session expiry, or
 * hard failures so User A's state never bleeds into User B's dashboard.
 */

import { supabase } from "@/integrations/supabase/client";

export const STATIC_DISCHARGE_EVENT = "hybrid-ai:static-discharged";

/** Keys / prefixes that hold user-scoped session charge (safe to wipe on switch). */
const USER_SCOPED_EXACT = new Set([
  "hybrid:allowTokenless",
  "hybrid-radio-sync-history",
  "vocal_liability_accepted",
]);

const USER_SCOPED_PREFIXES = [
  "sb-",
  "hybrid.studio.",
  "hybrid.guest.",
  "hybrid-ai:",
  "hybrid.vault.",
  "hybrid:vault",
  "hybrid.engine.",
] as const;

/** Cosmetic prefs kept across account switches unless `aggressive` logout. */
const PRESERVE_ON_SOFT_DISCHARGE = new Set([
  "har_language",
  "hybrid.i18n.language",
  "hybrid-glow-intensity",
  "hybrid-glow-strength",
]);

let lastAuthUserId: string | null = null;
let chargeMonitorInstalled = false;

function isUserScopedKey(key: string, aggressive: boolean): boolean {
  if (!aggressive && PRESERVE_ON_SOFT_DISCHARGE.has(key)) return false;
  if (USER_SCOPED_EXACT.has(key)) return true;
  return USER_SCOPED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Wipe user-scoped localStorage / sessionStorage residue. */
export function dischargeBrowserCaches(options?: { aggressive?: boolean }): void {
  if (typeof window === "undefined") return;
  const aggressive = options?.aggressive === true;

  try {
    const localKeys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key) localKeys.push(key);
    }
    for (const key of localKeys) {
      if (aggressive || isUserScopedKey(key, aggressive)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* private mode / blocked storage */
  }

  try {
    const sessionKeys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key) sessionKeys.push(key);
    }
    for (const key of sessionKeys) {
      if (aggressive || isUserScopedKey(key, true) || key.startsWith("hybrid")) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    /* ignore */
  }

  window.dispatchEvent(
    new CustomEvent(STATIC_DISCHARGE_EVENT, {
      detail: { aggressive, at: Date.now() },
    }),
  );
}

export type DischargeSessionOptions = {
  /** Sign out of Supabase (default true). */
  signOut?: boolean;
  /** Clear cosmetic prefs too (default false; true on explicit logout). */
  aggressive?: boolean;
  /** Clear TanStack Query cache when a client is provided. */
  clearQueryClient?: { cancelQueries: () => Promise<unknown>; clear: () => void } | null;
  /** Navigate after discharge. */
  redirectTo?: string | null;
  /** Preserve return path for re-auth (sessionStorage). */
  preserveReturnPath?: boolean;
};

/**
 * Full static discharger: terminates auth charge, bleeds caches, optional redirect.
 */
export async function dischargeSessionState(
  options: DischargeSessionOptions = {},
): Promise<void> {
  if (typeof window === "undefined") return;

  const {
    signOut = true,
    aggressive = false,
    clearQueryClient = null,
    redirectTo = null,
    preserveReturnPath = false,
  } = options;

  if (preserveReturnPath) {
    const path = `${window.location.pathname}${window.location.search}`;
    if (path.startsWith("/") && !path.startsWith("//")) {
      try {
        window.sessionStorage.setItem("hybrid-ai:reauth-return", path);
      } catch {
        /* ignore */
      }
    }
  }

  if (clearQueryClient) {
    try {
      await clearQueryClient.cancelQueries();
      clearQueryClient.clear();
    } catch {
      /* ignore */
    }
  }

  if (signOut) {
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  }

  lastAuthUserId = null;
  dischargeBrowserCaches({ aggressive });

  if (redirectTo) {
    window.location.assign(redirectTo);
  }
}

/**
 * Static charger monitor: listens for auth state changes and discharges residue
 * on logout or account switch so shared devices cannot bleed profiles.
 */
export function installStaticChargeMonitor(): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (chargeMonitorInstalled) return () => undefined;
  chargeMonitorInstalled = true;

  void supabase.auth.getSession().then(({ data }) => {
    lastAuthUserId = data.session?.user?.id ?? null;
  });

  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    const nextId = session?.user?.id ?? null;

    if (event === "SIGNED_OUT") {
      // Bleed off static charge without recursive signOut.
      lastAuthUserId = null;
      dischargeBrowserCaches({ aggressive: false });
      return;
    }

    if (
      (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") &&
      lastAuthUserId &&
      nextId &&
      lastAuthUserId !== nextId
    ) {
      // Account switch on a shared device — wipe prior user's studio/vault residue.
      console.warn("[static-charge] account switch detected — discharging prior user caches", {
        from: lastAuthUserId,
        to: nextId,
      });
      dischargeBrowserCaches({ aggressive: false });
    }

    if (nextId) lastAuthUserId = nextId;
  });

  return () => {
    data.subscription.unsubscribe();
    chargeMonitorInstalled = false;
  };
}
