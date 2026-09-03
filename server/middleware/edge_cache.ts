import { defineEventHandler, getRequestURL, setResponseHeaders } from "h3";
import { cacheHeadersForPath } from "../../src/lib/cache-headers.server";

/**
 * Leftover h3 path: stamp Cache-Control from the shared policy.
 * Never sets immutable on signed stream redirects or private APIs.
 */
export default defineEventHandler((event) => {
  const url = getRequestURL(event);
  setResponseHeaders(event, cacheHeadersForPath(url.pathname || "/", url.search || ""));
});
