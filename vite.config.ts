import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";
import { VitePWA } from "vite-plugin-pwa";
import { lovableAssetDevMiddleware } from "./src/lib/lovable-asset-proxy.server";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode || process.env.NODE_ENV || "development", process.cwd(), "");
  Object.assign(process.env, env);

  return {
    envPrefix: ["VITE_", "NEXT_PUBLIC_"],
    server: {
      port: 8080,
      host: true,
      // Same-origin UI (8080) → FastAPI :8880.
      proxy: {
        "/generate": { target: "http://127.0.0.1:8880", changeOrigin: true, timeout: 300000, proxyTimeout: 300000 },
        "/api/tracks": { target: "http://127.0.0.1:8880", changeOrigin: true, timeout: 300000, proxyTimeout: 300000 },
        "/api/stream": { target: "http://127.0.0.1:8880", changeOrigin: true, timeout: 300000, proxyTimeout: 300000 },
      },
      // FMA / large data trees are often locked or huge on Windows; watching them
      // crashes the watcher with EBUSY and is never useful for HMR.
      watch: {
        ignored: [
          "**/data/**",
          "**/node_modules/**",
          "**/.git/**",
          "**/test-results/**",
          "**/playwright-report/**",
        ],
      },
    },
    resolve: {
      dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-query"],
    },
    plugins: [
      {
        name: "lovable-asset-proxy",
        configureServer(server) {
          server.middlewares.use(lovableAssetDevMiddleware());
        },
        configurePreviewServer(server) {
          server.middlewares.use(lovableAssetDevMiddleware());
        },
      },
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
          // Client files are copied to .output/public after this plugin's
          // closeBundle, so dist is empty and a precache glob only warns.
          // Registration is paused in src/lib/register-sw.ts; runtime caching
          // is what a later re-enable should use.
          globPatterns: [],
          navigateFallback: undefined,
          maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
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
                sameOrigin && url.pathname.startsWith("/assets/"),
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
