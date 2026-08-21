/**
 * React glue between the selected UI language and money formatting.
 *
 * Components should use these hooks instead of calling formatAmount/priceLabel
 * directly, so prices re-render (and re-localise) the moment the visitor
 * switches language.
 */
import { useCallback, useMemo } from "react";
import { localeForLanguage, useLanguageState } from "@/lib/i18n";
import {
  amountFor,
  formatAmount,
  priceLabel,
  type CurrencyCode,
  type FormatMoneyOptions,
} from "@/lib/pricing";

export function useMoneyLocale(): string {
  const { language } = useLanguageState();
  return localeForLanguage(language);
}

export function useMoneyFormat() {
  const locale = useMoneyLocale();

  const format = useCallback(
    (minor: number, currency: CurrencyCode, options: FormatMoneyOptions = {}) =>
      formatAmount(minor, currency, { locale, ...options }),
    [locale],
  );

  const label = useCallback(
    (priceId: string, currency: CurrencyCode, options: FormatMoneyOptions = {}) =>
      priceLabel(priceId, currency, { locale, ...options }),
    [locale],
  );

  const amount = useCallback(
    (priceId: string, currency: CurrencyCode) => amountFor(priceId, currency),
    [],
  );

  return useMemo(() => ({ locale, format, label, amount }), [locale, format, label, amount]);
}
