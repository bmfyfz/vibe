import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Where the API is while the page is served by Vite's own dev server: a Vibe
// on this machine. In production there is nothing to say: the Worker, or
// `vibe serve`, serves the page and the API from one origin.
const api = process.env["VIBE_URL"] ?? "http://127.0.0.1:7473";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The page's requests go to its own origin, and are passed on from there.
    // The origin a browser reports is kept as it is, since the API checks it
    // against the address it was asked at: so the address is kept too.
    proxy: { "/v1": { target: api, ws: true, changeOrigin: false, xfwd: false } },
  },
  build: {
    outDir: "dist",
    // One stylesheet and one script, both from this origin: the page's
    // content security policy allows nothing else.
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    // React and the Markdown renderer are most of it, and all of it is needed at once.
    chunkSizeWarningLimit: 600,
  },
});
