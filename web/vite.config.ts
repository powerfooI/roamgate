import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the web app talks to the bridge through Vite's proxy so the
// frontend can use a relative /ws URL (same origin, no hardcoded port).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^shiki$/,
        replacement: fileURLToPath(new URL("./src/shiki.ts", import.meta.url)),
      },
    ],
  },
  worker: {
    format: "es",
  },
  build: {
    // The asset check follows static imports from the entry, excluding lazy features.
    manifest: true,
    // Build straight into the server's static dir so the backend can serve it.
    outDir: "../server/public",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Group small grammars into lazy chunks to keep expanded highlighting
        // within the embedded server's asset-count budget.
        manualChunks(id) {
          const language = id.match(
            /@shikijs\/langs\/dist\/([^/]+)\.mjs$/,
          )?.[1];
          if (!language) return;
          if (
            [
              "awk",
              "diff",
              "docker",
              "ini",
              "json5",
              "jsonl",
              "make",
              "nginx",
              "proto",
              "toml",
              "xml",
              "yaml",
            ].includes(language)
          ) {
            return "syntax-config";
          }
          if (
            [
              "clojure",
              "crystal",
              "elixir",
              "elm",
              "erlang",
              "fsharp",
              "groovy",
              "haskell",
              "kotlin",
              "common-lisp",
              "lua",
              "r",
              "scala",
            ].includes(language)
          ) {
            return "syntax-extra";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "http://127.0.0.1:8787", ws: true },
      "/api": { target: "http://127.0.0.1:8787" },
      // Let an unauthenticated dev client reach the bridge login page instead
      // of repeatedly loading the Vite SPA at /login and redirecting again.
      "/login": { target: "http://127.0.0.1:8787" },
    },
  },
});
