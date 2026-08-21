/**
 * Error type for site-settings changes (currency, language, divisions).
 *
 * `applied: true` means the change did take effect for this session but could
 * not be persisted — the UI shows a warning-style error instead of implying
 * nothing happened.
 */
export class SettingsError extends Error {
  readonly applied: boolean;

  constructor(message: string, options?: { applied?: boolean }) {
    super(message);
    this.name = "SettingsError";
    this.applied = options?.applied ?? false;
  }
}

/** Human-readable message for anything thrown by a settings action. */
export function settingsErrorMessage(error: unknown): string {
  if (error instanceof SettingsError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong applying that setting. Please try again.";
}
