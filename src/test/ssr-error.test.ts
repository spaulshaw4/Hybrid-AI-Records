import { describe, expect, it } from "vitest";
import {
  isH3SwallowedErrorBody,
  isIntentionalHttpResult,
  unwrapSsrError,
} from "@/lib/ssr-error";

describe("h3 swallowed SSR body", () => {
  it("detects the generic unhandled HTTPError JSON h3 returns", () => {
    expect(
      isH3SwallowedErrorBody(
        JSON.stringify({ status: 500, unhandled: true, message: "HTTPError" }),
      ),
    ).toBe(true);
  });

  it("ignores real JSON 500s and invalid payloads", () => {
    expect(isH3SwallowedErrorBody(JSON.stringify({ status: 500, message: "db down" }))).toBe(
      false,
    );
    expect(isH3SwallowedErrorBody("not json")).toBe(false);
  });
});

describe("intentional HTTP results", () => {
  it("lets Responses and 4xx objects through", () => {
    expect(isIntentionalHttpResult(new Response(null, { status: 401 }))).toBe(true);
    expect(isIntentionalHttpResult({ status: 404, message: "missing" })).toBe(true);
    expect(isIntentionalHttpResult({ statusCode: 302 })).toBe(true);
  });

  it("does not treat unhandled h3 HTTPErrors as intentional", () => {
    const error = Object.assign(new Error("boom"), { status: 500, unhandled: true });
    expect(isIntentionalHttpResult(error)).toBe(false);
    expect(isIntentionalHttpResult({ status: 500 })).toBe(false);
  });
});

describe("unwrapSsrError", () => {
  it("returns the original Error from an unhandled HTTPError.cause", () => {
    const original = new Error("Cannot read properties of undefined (reading 'map')");
    const wrapped = Object.assign(new Error("HTTPError"), {
      unhandled: true,
      status: 500,
      cause: original,
    });
    expect(unwrapSsrError(wrapped)).toBe(original);
  });

  it("unwraps Node's { cause, unhandled } details object", () => {
    const original = new Error("loader exploded");
    const wrapped = Object.assign(new Error("HTTPError"), {
      unhandled: true,
      status: 500,
      cause: { cause: original, unhandled: true },
    });
    expect(unwrapSsrError(wrapped)).toBe(original);
  });

  it("leaves ordinary errors alone", () => {
    const error = new Error("plain");
    expect(unwrapSsrError(error)).toBe(error);
  });
});
