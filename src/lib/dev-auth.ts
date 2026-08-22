/**
 * Temporary local-development auth bypass.
 *
 * Compile-time false in production Vite builds (`import.meta.env.PROD`).
 * Also requires NODE_ENV === "development" when process is available.
 * Never enable this for preview/production deploys.
 */

export const DEV_TEST_USER = {
  id: "dev-test-user",
  email: "test@hybridengine.ai",
} as const;

/** Postgres uuid used when a local-dev generate hits the database. */
export const DEV_TEST_USER_UUID = "11111111-1111-4111-8111-111111111111";

export const DEV_TEST_TOKEN_BALANCE = 10;
export const DEV_TEST_VOICE_ID = "dev-test-voice";

type DevEnv = {
  DEV?: boolean;
  PROD?: boolean;
  NODE_ENV?: string;
};

export function isDevAuthBypass(
  env: DevEnv = {
    DEV: import.meta.env.DEV,
    PROD: import.meta.env.PROD,
    NODE_ENV: typeof process !== "undefined" ? process.env.NODE_ENV : undefined,
  },
): boolean {
  if (env.PROD) return false;
  // Vite `npm run dev` can still inject NODE_ENV=production into the client.
  // Trust the compile-time DEV flag first.
  if (env.DEV === true) return true;
  return env.NODE_ENV === "development";
}
