import { useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";

/**
 * Snapshot of *where* an error happened, safe to show a visitor and safe to log.
 * Values that commonly carry personal or secret data (emails, tokens, resume
 * links, payment session ids) are masked before they ever reach the screen.
 */
export type ErrorRouteContext = {
  /** Reference the visitor can quote to support. */
  reference: string;
  /** Matched route id, e.g. "/order-status" — falls back to the pathname. */
  routeId: string;
  pathname: string;
  /** Redacted "key=value" pairs from the URL params. */
  params: string[];
  /** Redacted "key=value" pairs from the search/query string. */
  search: string[];
  /** Which stage failed, when the router tells us. */
  stage: "loader" | "render";
};

const SENSITIVE = /(token|secret|key|password|email|mail|sig|signature|session|auth|phone|address|name)/i;

function maskValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value !== "string") return "[object]";
  if (SENSITIVE.test(key)) {
    // Keep a short shape hint so the value is recognisable without leaking it.
    return value.length <= 2 ? "•••" : `${value.slice(0, 2)}•••(${value.length})`;
  }
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

function describe(record: Record<string, unknown> | undefined): string[] {
  if (!record) return [];
  return Object.entries(record)
    .slice(0, 8)
    .map(([key, value]) => `${key}=${maskValue(key, value)}`);
}

function makeReference(pathname: string): string {
  // Deterministic-ish short id: timestamp in base36 plus a path hash, so the
  // same reference appears in the visitor's screenshot and in the console log.
  let hash = 0;
  for (let i = 0; i < pathname.length; i += 1) {
    hash = (hash * 31 + pathname.charCodeAt(i)) >>> 0;
  }
  return `${Date.now().toString(36)}-${hash.toString(36)}`.toUpperCase();
}

/** Reads the failing match from the router and builds a redacted summary. */
export function useErrorRouteContext(error: unknown): ErrorRouteContext {
  const snapshot = useRouterState({
    select: (state) => {
      const matches = state.matches;
      const failing = [...matches].reverse().find((m) => m.status === "error") ?? matches.at(-1);
      return {
        routeId: (failing?.routeId as string | undefined) ?? state.location.pathname,
        pathname: state.location.pathname,
        params: failing?.params as Record<string, unknown> | undefined,
        search: (failing?.search ?? state.location.search) as Record<string, unknown> | undefined,
        loaderFailed: failing?.status === "error",
      };
    },
  });

  return useMemo(() => {
    const context: ErrorRouteContext = {
      reference: makeReference(snapshot.pathname),
      routeId: snapshot.routeId,
      pathname: snapshot.pathname,
      params: describe(snapshot.params),
      search: describe(snapshot.search),
      stage: snapshot.loaderFailed ? "loader" : "render",
    };

    console.error("[route-error]", {
      reference: context.reference,
      routeId: context.routeId,
      stage: context.stage,
      params: context.params,
      search: context.search,
      message: error instanceof Error ? error.message : String(error),
    });

    return context;
    // Recompute only when the error identity or location changes.
  }, [error, snapshot.pathname, snapshot.routeId, snapshot.loaderFailed]);
}
