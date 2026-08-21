/**
 * V Engine beta flag.
 *
 * During the beta, cinematic renders are not blocked by the V Token wallet:
 * if the balance can't cover the render (or the wallet errors out), the render
 * still runs and the shortfall is simply not charged. Flip this to `false` at
 * launch to enforce strict charging again.
 */
export const V_RENDER_BETA = true;

/** Copy shown next to the cost breakdown while the beta is on. */
export const V_BETA_NOTICE =
  "Beta: full-length test renders run even when your V Token balance is short — you're only charged when you have tokens.";
