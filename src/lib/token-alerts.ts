/**
 * Hybrid Token balance alerts.
 *
 * Two moments matter to an artist mid-session:
 *  1. the balance dropped low enough that the next few actions will run out;
 *  2. an action they just clicked costs more tokens than they hold.
 *
 * Both surface as in-app toasts. The low-balance warning is de-duplicated per
 * balance value so a burst of refreshes cannot spam the same notice.
 */

/** Tokens charged for one Hybrid Voice Conversion (RVC v2) run. */
export const CONVERSION_TOKEN_COST = 1;

/** Tokens charged for one master track generation. */
export const GENERATION_TOKEN_COST = 1;

/** At or below this balance we warn the artist to top up. */
export const LOW_BALANCE_THRESHOLD = 2;

export type TokenToast = {
  level: "warning" | "error";
  title: string;
  description: string;
};

/** Warning to show when the balance is running out, or null when it's healthy. */
export function lowBalanceToast(balance: number): TokenToast | null {
  if (balance > LOW_BALANCE_THRESHOLD) return null;
  if (balance <= 0) {
    return {
      level: "error",
      title: "You're out of Hybrid Tokens",
      description: "Top up in the token store to generate or convert another master.",
    };
  }
  return {
    level: "warning",
    title: `Low balance — ${balance} Hybrid Token${balance === 1 ? "" : "s"} left`,
    description: "Top up soon so your next generation or voice conversion doesn't stall.",
  };
}

/** Blocking notice when an action costs more than the artist holds. */
export function insufficientBalanceToast(balance: number, cost: number, action: string): TokenToast {
  return {
    level: "error",
    title: `Not enough Hybrid Tokens for ${action}`,
    description: `${action} costs ${cost} token${cost === 1 ? "" : "s"} and you have ${balance}. Top up to continue.`,
  };
}

/** True when the balance covers the cost. */
export function canAfford(balance: number | null, cost: number): boolean {
  return balance === null || balance >= cost;
}

/** Tracks which balance values have already been warned about this session. */
export function createLowBalanceGate() {
  let lastWarned: number | null = null;
  return {
    /** Returns the toast to show, or null when it was already shown for this balance. */
    next(balance: number): TokenToast | null {
      const toast = lowBalanceToast(balance);
      if (!toast) {
        lastWarned = null;
        return null;
      }
      if (lastWarned === balance) return null;
      lastWarned = balance;
      return toast;
    },
  };
}
