import { useEffect, useState } from "react";

type ApplePayWindow = Window & {
  ApplePaySession?: {
    canMakePayments?: () => boolean;
    supportsVersion?: (version: number) => boolean;
  };
};

/**
 * True when this device/browser can actually present an Apple Pay sheet.
 * Safari on Apple hardware exposes `ApplePaySession`; everywhere else the
 * wallet simply doesn't exist, so we never advertise it.
 */
export function isApplePayAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const session = (window as ApplePayWindow).ApplePaySession;
  if (!session?.canMakePayments) return false;
  try {
    return session.canMakePayments() === true;
  } catch {
    return false;
  }
}

/**
 * Asks the browser whether a Google Pay instrument can be presented. Chrome,
 * Edge and Android WebViews implement the Payment Request API; Safari answers
 * false for the Google Pay method, so the two wallets never both show unless
 * the device genuinely supports both.
 */
export async function checkGooglePayAvailable(): Promise<boolean> {
  if (typeof window === "undefined" || !("PaymentRequest" in window)) return false;
  try {
    const request = new PaymentRequest(
      [
        {
          supportedMethods: "https://google.com/pay",
          data: {
            apiVersion: 2,
            apiVersionMinor: 0,
            allowedPaymentMethods: [
              {
                type: "CARD",
                parameters: {
                  allowedAuthMethods: ["PAN_ONLY", "CRYPTOGRAM_3DS"],
                  allowedCardNetworks: ["AMEX", "DISCOVER", "MASTERCARD", "VISA"],
                },
                tokenizationSpecification: {
                  type: "PAYMENT_GATEWAY",
                  parameters: { gateway: "stripe" },
                },
              },
            ],
          },
        },
      ],
      // Probe only — this request is never shown to the customer.
      { total: { label: "Availability check", amount: { currency: "USD", value: "1.00" } } },
    );
    return await request.canMakePayment().then((v) => v === true);
  } catch {
    return false;
  }
}

/** SSR-safe hook: always false on the server and on the first paint. */
export function useApplePayAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    setAvailable(isApplePayAvailable());
  }, []);
  return available;
}

/** SSR-safe hook mirroring `useApplePayAvailable` for Google Pay. */
export function useGooglePayAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    checkGooglePayAvailable().then((ok) => {
      if (active) setAvailable(ok);
    });
    return () => {
      active = false;
    };
  }, []);
  return available;
}
