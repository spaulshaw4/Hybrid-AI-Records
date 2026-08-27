import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "@/lib/client-error-report";
import { addBreadcrumb } from "@/lib/client-breadcrumbs";

type Props = {
  children: ReactNode;
  /** Short label for diagnostics (e.g. "engine", "portal"). */
  region?: string;
  /** Optional reset callback when the user taps Recover. */
  onReset?: () => void;
};

type State = { error: Error | null; reference?: string };

/**
 * Local bounce-back boundary for heavy studio / portal surfaces.
 * Isolates a bad sub-tree so the rest of the app does not white-screen.
 */
export class StudioErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[StudioErrorBoundary:${this.props.region ?? "studio"}]`, error);
    const reference = reportClientError(error, {
      source: "studio_error_boundary",
      severity: "non-fatal",
      componentStack: info.componentStack ?? undefined,
      extra: { region: this.props.region ?? "studio", recovered: true },
    });
    if (reference) this.setState({ reference });
  }

  private reset = () => {
    addBreadcrumb("error", "studio-boundary:recover", {
      region: this.props.region ?? "studio",
      reference: this.state.reference ?? "none",
    });
    this.props.onReset?.();
    this.setState({ error: null, reference: undefined });
  };

  render() {
    const { error, reference } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="mx-auto my-8 flex max-w-lg flex-col items-center gap-3 rounded-xl border border-white/[0.08] bg-zinc-900/70 px-6 py-8 text-center text-white shadow-2xl backdrop-blur-xl"
      >
        <h2 className="text-lg font-semibold">This panel hit a snag</h2>
        <p className="text-sm text-zinc-300">
          Your session and vault are intact. Recover this view without reloading the whole site —
          nothing extra was charged.
        </p>
        {reference ? (
          <p className="font-mono text-xs text-zinc-500">Ref {reference}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-zinc-950"
          >
            Recover panel
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-white/20 px-4 py-2 text-sm font-medium text-white"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
