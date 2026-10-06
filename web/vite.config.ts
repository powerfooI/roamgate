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
    // Retain Vite 5's browser baseline instead of Vite 7's newer default.
    target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
    // The asset check follows static imports from the entry, excluding lazy features.
    manifest: true,
    // Build straight into the server's static dir so the backend can serve it.
    outDir: "../server/public",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // Global assistant and workspace clients share this startup transport.
              name: "bridge-client",
              test: /src[\\/](?:api|connectionHttp|useConnectionClient)\.tsx?$/,
            },
            {
              // These startup preferences share storage; keep their small
              // helpers together instead of adding utility-only requests.
              name: "browser-preferences",
              test: /src[\\/](?:browserStorage|layoutPreferences|shortcutPreferences)\.ts$/,
            },
            {
              // Share startup React and icons without loading feature-only icons.
              name: "ui-runtime",
              test: /node_modules[\\/](?:lucide-react|react|react-dom|scheduler)[\\/]/,
              tags: ["$initial"],
            },
            {
              // The remaining icons belong to lazy features; retain one small asset.
              name: "feature-icons",
              test: /node_modules[\\/]lucide-react[\\/]/,
            },
            {
              // File and code previews load these together. Preserve one lazy editor
              // boundary instead of a separate chunk for each editor package.
              name: "code-preview",
              test: /node_modules[\\/](?:@codemirror|@lezer|codemirror)[\\/]/,
            },
            {
              name: "syntax-config",
              test: /@shikijs\/langs\/dist\/(awk|diff|docker|ini|json5|jsonl|make|nginx|proto|toml|xml|yaml)\.mjs$/,
            },
            {
              name: "syntax-extra",
              test: /@shikijs\/langs\/dist\/(clojure|crystal|elixir|elm|erlang|fsharp|groovy|haskell|kotlin|common-lisp|lua|r|scala)\.mjs$/,
            },
          ],
        },
      },
    },
  },

  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "http://127.0.0.1:8788", ws: true },
      "/api": { target: "http://127.0.0.1:8788" },
      // Installation metadata is instance-specific, including in development.
      "/manifest.json": { target: "http://127.0.0.1:8788" },
      // Let an unauthenticated dev client reach the bridge login page instead
      // of repeatedly loading the Vite SPA at /login and redirecting again.
      "/login": { target: "http://127.0.0.1:8788" },
    },
  },
});
