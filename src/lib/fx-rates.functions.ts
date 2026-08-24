import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { FxRateMap } from "@/lib/fx";

/**
 * Public read: the storefront needs the live daily rates so displayed prices
 * match what checkout will charge.
 */
export const getFxRates = createServerFn({ method: "GET" })
  // Takes no input: reject anything sent so the endpoint stays a pure read.
  .validator((data: unknown) => z.undefined().or(z.null()).parse(data ?? undefined))
  .handler(
  async (): Promise<FxRateMap> => {
    const { readFxRates } = await import("@/lib/fx-rates.server");
    return readFxRates();
  },
);
