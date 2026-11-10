import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

// Installable on iPhone and laptop. Only the app shell is cached: numbers always
// come from the network, so the app never shows yesterday's prices as today's.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/*.png", "icons/mark.svg"],
      manifest: {
        name: "Big Surf Bets",
        short_name: "Bets",
        description: "Expected points, lineups and prices for this week's NFL games.",
        start_url: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#050F1C",
        theme_color: "#050F1C",
        icons: [
          { src: "/icons/web-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/web-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/web-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/icons/web-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: { navigateFallback: "/index.html", globPatterns: ["**/*.{js,css,html,svg,png,woff2}"] },
    }),
  ],
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
