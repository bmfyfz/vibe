import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
  // The web app, as `bun web:build` leaves it. To the Worker's build these are
  // files to serve as they are: the Worker's static assets, with the headers
  // that `_headers` there gives them. See `assets` in cloudflare.config.ts.
  publicDir: "../web/dist",
  server: { port: 8787, strictPort: true },
});
