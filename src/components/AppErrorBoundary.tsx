import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportLovableError } from "@/lib/lovable-error-reporting";
import { addBreadcrumb } from "@/lib/client-breadcrumbs";
import { reportClientError } from "@/lib/client-error-report";
import { recordRenderIncident } from "@/lib/webkit-safe-mode";

/**
 * Last-resort client boundary + emergency static discharger.
 *
 * Catches unexpected runtime crashes / auth collisions and offers a hard
 * discharge so users are never trapped in a broken residue loop.
 */

type Props = { children: ReactNode };
type State = { error: Error | null; reference?: string };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught platform error caught by boundary:", error, info);
    const componentStack = info.componentStack ?? undefined;
    reportLovableError(error, {
      boundary: "app_error_boundary",
      componentStack,
      name: error?.name,
    });
    const reference = reportClientError(error, {
      source: "app_error_boundary",
      severity: "non-fatal",
      componentStack,
      extra: { recovered: true, isDomException: error?.name?.includes("Error") === true },
    });
    recordRenderIncident("boundary-recovery");
    if (reference) this.setState({ reference });
  }

  private reset = () => {
    addBreadcrumb("error", "boundary:continue", { reference: this.state.reference ?? "none" });
    this.setState({ error: null, reference: undefined });
  };

  /** Emergency circuit breaker — aggressive purge + clean slate home. */
  private handleEmergencyDischarge = () => {
    addBreadcrumb("error", "boundary:emergency-discharge", {
      reference: this.state.reference ?? "none",
    });
    if (typeof window === "undefined") return;
    void import("@/lib/static-charge")
      .then(({ dischargeSessionState }) =>
        dischargeSessionState({
          signOut: true,
          aggressive: true,
          redirectTo: "/",
        }),
      )
      .catch(() => {
        try {
          window.localStorage.clear();
          window.sessionStorage.clear();
        } catch {
          /* ignore */
        }
        window.location.href = "/";
      });
  };

  render() {
    const { error, reference } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background/40 px-6 text-center backdrop-blur-sm">
        <div className="max-w-md rounded-xl border border-border bg-card/95 p-8 shadow-2xl">
          <h1 className="text-2xl font-semibold text-destructive">System Interruption Detected</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            An unexpected state exception occurred. The safety discharger can isolate your session
            to prevent residual cache or credentials from bleeding into the next login.
          </p>
          {reference ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Reference <span className="font-mono text-foreground">{reference}</span> — saved to{" "}
              <a className="underline" href="/diagnostics">
                diagnostics
              </a>
            </p>
          ) : null}
          <div className="mt-6 flex flex-col gap-3">
            <button
              type="button"
              onClick={this.handleEmergencyDischarge}
              className="w-full rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground"
            >
              Perform Emergency Discharge &amp; Reset
            </button>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={this.reset}
                className="rounded-md border border-border px-5 py-2.5 font-medium text-foreground"
              >
                Continue
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-md border border-border px-5 py-2.5 font-medium text-foreground"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }
}
