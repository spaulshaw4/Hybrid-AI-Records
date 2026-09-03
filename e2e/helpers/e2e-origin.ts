/**
 * Default Playwright origin when `E2E_BASE_URL` is unset.
 * Keep in lockstep with `E2E_PORT` in playwright.config.ts.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8085);
export const E2E_ORIGIN = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;
