import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
    envPrefix: ["VITE_", "NEXT_PUBLIC_"],
    server: {
      port: 8080,
      host: true,
    },
    resolve: {
      dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-query"],
    },
    plugins: [
      tsConfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        srcDirectory: "src",
        server: { entry: "server" },
      }),
      ...(command === "build" ? [nitro()] : []),
      viteReact(),
      tailwindcss(),
      VitePWA({
        strategies: "generateSW",
        registerType: "autoUpdate",
        injectRegister: null,
        filename: "sw.js",
        devOptions: { enabled: false },
        manifest: {
          name: "Hybrid AI Records",
          short_name: "Hybrid AI",
          description:
            "Independent, veteran-owned record label. Fixed-cost, release-ready tracks.",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#05070b",
          theme_color: "#05070b",
          icons: [{ src: "/favicon.jpg", sizes: "512x512", type: "image/jpeg" }],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,jpg,webp,woff2}"],
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
          navigateFallback: "/",
          navigateFallbackDenylist: [/^\/~oauth/, /^\/api\//],
          runtimeCaching: [
            {
              urlPattern: ({ request, sameOrigin }) =>
                sameOrigin && request.mode === "navigate",
              handler: "NetworkFirst",
              options: {
                cacheName: "html-navigations",
                networkTimeoutSeconds: 5,
                expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 7 },
              },
            },
            {
              urlPattern: ({ url, sameOrigin }) =>
                sameOrigin && url.pathname.startsWith("/_build/"),
              handler: "CacheFirst",
              options: {
                cacheName: "built-assets",
                expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
      }),
    ],
  };
});
