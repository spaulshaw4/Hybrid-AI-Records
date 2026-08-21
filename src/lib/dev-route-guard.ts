import { notFound } from "@tanstack/react-router";

/**
 * Guard for internal /dev/* harness pages.
 *
 * These pages are development tooling (rendering harnesses, translation
 * coverage audits, background reports). robots.txt only discourages crawlers,
 * so the routes themselves must refuse to render outside development.
 */
export function devOnlyBeforeLoad() {
  if (!import.meta.env.DEV) throw notFound();
}
