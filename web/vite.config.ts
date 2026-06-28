import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Hermes Tracker APP — Vite config
//
// Dev server runs on :5173 with a proxy to the bot's HTTP API at :8080.
// In production, Tauri (Phase 5) wraps the built static files in
// `web/dist/` and connects to the bot at 127.0.0.1:8080 directly.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        ws: true, // SSE support
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
});