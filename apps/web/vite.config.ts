import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  optimizeDeps: {
    // These packages are reached through lazy timeline renderers. Pre-bundle
    // them together so opening a task doesn't invalidate already-served deps.
    include: [
      "@streamdown/cjk",
      "@streamdown/code",
      "@streamdown/math",
      "@streamdown/mermaid",
      "motion/react",
      "shiki",
      "streamdown",
    ],
  },
  server: {
    // Vite 8 enables browser-console forwarding automatically when it detects
    // a coding agent. Keep browser payloads out of control-plane terminal logs.
    forwardConsole: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4310",
        changeOrigin: false,
      },
      "/healthz": {
        target: "http://127.0.0.1:4310",
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
