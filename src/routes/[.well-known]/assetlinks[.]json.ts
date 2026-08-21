import { createFileRoute } from "@tanstack/react-router";

/**
 * Digital Asset Links for the Android TWA (the APK produced by PWABuilder).
 *
 * Android fetches this file to confirm the APK is allowed to render
 * hybrid-ai-records.com without a browser address bar. Fill the signing
 * fingerprint(s) via env once PWABuilder generates the package:
 *
 *   ANDROID_PACKAGE_NAME    e.g. com.hybridairecords.twa
 *   ANDROID_SHA256_FINGERPRINTS  comma-separated AA:BB:.. SHA-256 certificate hashes
 *     (include BOTH the local signing key and the Play App Signing key)
 */
export const Route = createFileRoute("/.well-known/assetlinks.json")({
  server: {
    handlers: {
      GET: () => {
        const packageName =
          process.env["ANDROID_PACKAGE_NAME"] ?? "com.hybridairecords.twa";
        const fingerprints = (process.env["ANDROID_SHA256_FINGERPRINTS"] ?? "")
          .split(",")
          .map((value) => value.trim().toUpperCase())
          .filter(Boolean);

        const body = fingerprints.length
          ? [
              {
                relation: ["delegate_permission/common.handle_all_urls"],
                target: {
                  namespace: "android_app",
                  package_name: packageName,
                  sha256_cert_fingerprints: fingerprints,
                },
              },
            ]
          : [];

        return new Response(JSON.stringify(body, null, 2), {
          headers: {
            "content-type": "application/json",
            // Android re-checks periodically; keep it short so a new
            // fingerprint takes effect without waiting on a CDN cache.
            "cache-control": "public, max-age=300",
          },
        });
      },
    },
  },
});
