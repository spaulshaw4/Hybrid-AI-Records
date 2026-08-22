import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.development" });
dotenv.config({ path: ".env" });

import { createStart, createMiddleware } from "@tanstack/react-start";

import { recordCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { withSecurityHeaders } from "./lib/security-headers";
import { logServerError, newErrorReference } from "./lib/server-error-log";
import { isIntentionalHttpResult, unwrapSsrError } from "./lib/ssr-error";
import { authenticatedFunctionMiddleware } from "@/lib/authenticated-function-middleware";

const securityHeadersMiddleware = createMiddleware().server(async ({ next }) => {
  const result = await next();
  const response = (result as { response?: Response }).response;
  if (response instanceof Response) withSecurityHeaders(response);
  return result;
});

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    // Intentional HTTP outcomes (401 from requireSupabaseAuth, redirects, 4xx)
    // must pass through untouched — wrapping them in the 500 error page hides
    // the real status. Unhandled h3 HTTPErrors also have `.status` (500) and
    // must NOT be rethrown, or h3 serializes them as {"message":"HTTPError"}.
    if (isIntentionalHttpResult(error)) throw error;

    const original = unwrapSsrError(error);
    recordCapturedError(original);
    const reference = newErrorReference("request-middleware");
    logServerError(original, { reference, source: "request-middleware" });
    return withSecurityHeaders(
      new Response(renderErrorPage(reference), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  }
});

export const startInstance = createStart(() => ({
  functionMiddleware: [authenticatedFunctionMiddleware],
  requestMiddleware: [securityHeadersMiddleware, errorMiddleware],
}));
