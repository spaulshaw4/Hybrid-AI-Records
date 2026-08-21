import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportLovableError } from "@/lib/lovable-error-reporting";
import { addBreadcrumb } from "@/lib/client-breadcrumbs";
import { reportClientError } from "@/lib/client-error-report";
import { recordRenderIncident } from "@/lib/webkit-safe-mode";

/**
 * Last-resort client boundary.
 *
 * iOS Safari is where render failures hurt most: a throw inside the tree during
 * heavy audio generation or a session-state update unmounts everything and the
 * tab simply paints white. Router-level boundaries only cover route render, so
 * this wraps the whole app and also survives DOM exceptions (NotFoundError /
 * HierarchyRequestError) raised by third-party or DOM-mutating code.
 *
 * Because the boundary recovers the session, these are reported as *non-fatal*
 * with their stack + component stack + breadcrumb trail, and mirrored into the
 * local log at /diagnostics so intermittent white screens can be tracked over
 * time on the device that produced them.
 */

type Props = { children: ReactNode };
type State = { error: Error | null; reference?: string };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error);
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
    // Repeated boundary recoveries are the other Safe Mode trigger: the tree
    // is blowing up often enough that decoration is not worth the risk.
    recordRenderIncident("boundary-recovery");
    if (reference) this.setState({ reference });
  }

  private reset = () => {
    addBreadcrumb("error", "boundary:continue", { reference: this.state.reference ?? "none" });
    this.setState({ error: null, reference: undefined });
  };

  render() {
    const { error, reference } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-2xl font-semibold text-foreground">Something interrupted the page</h1>
        <p className="max-w-md text-muted-foreground">
          Your work is saved. Tap continue to reload this view — nothing was charged and no track
          was lost.
        </p>
        {reference ? (
          <p className="text-sm text-muted-foreground">
            Reference <span className="font-mono text-foreground">{reference}</span> — saved to{" "}
            <a className="underline" href="/diagnostics">
              diagnostics
            </a>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md bg-primary px-5 py-2.5 font-medium text-primary-foreground"
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
      </main>
    );
  }
}
