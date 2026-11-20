import { bindings, defineConfig, exports, triggers } from "cf/config";

import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

// This file is evaluated by `cf`, in Node, where `process` is. The Worker's
// own types, which this file is checked with, don't know of it.
declare const process: { env: Record<string, string | undefined> };

// The local D1 simulation is keyed by this ID, and `cf d1 migrations apply`
// takes an ID, not a name. `db:migrate:local` in package.json uses the same one.
const LOCAL_D1_ID = "00000000-0000-4000-8000-00000000b1be";

// The queue that prompts deliveries to watchers. It carries only which vibe to
// look at: what is owed to whom is in each watcher's cursor, in D1.
const DELIVERIES = "vibe-deliveries";

export default defineConfig({
  worker: ({ mode }) => ({
    name: "vibe-api",
    compatibilityDate: "2026-10-06",
    entrypoint,
    triggers: [
      // Each minute: due schedules, the task sweep, and watchers that are behind, in worker.ts.
      triggers.scheduled({ schedule: "* * * * *" }),
      // A write to a vibe with watchers asks for a delivery pass here. A batch
      // is handed over at once: a delivery should not wait for company.
      triggers.queue({ name: DELIVERIES, maxBatchSize: 10, maxBatchTimeout: 0 }),
    ],
    // The class in hub.ts, one object per vibe. It stores nothing; a Durable
    // Object still has to name a storage engine, and SQLite is the one new
    // classes get. The Worker reaches it through its own exports, so it needs
    // no binding in `env`.
    exports: { VibeHub: exports.durableObject({ storage: "sqlite" }) },
    // The web app is served by this Worker, from the same origin as the API:
    // that is what lets a browser's session be a cookie no page script can
    // read. The API's paths go to the Worker's code first. Every other path
    // is a file of the web app, or the app itself, which reads the path.
    assets: {
      notFoundHandling: "single-page-application",
      // The API's own root as well as everything under it.
      runWorkerFirst: ["/v1", "/v1/*"],
    },
    env: {
      DB: bindings.d1(
        mode === "development" ? { name: "vibe", id: LOCAL_D1_ID } : { name: "vibe" },
      ),
      FILES: bindings.r2({ name: "vibe-attachments" }),
      DELIVERIES: bindings.queue<{ vibeId: string }>({ name: DELIVERIES }),
      VIBE_ADMIN_SECRET: bindings.secret(),
      // The client ID of the GitHub OAuth app people sign in through with
      // `vibe login`, and whether an account that is no one's here may join.
      // Neither is a secret, and neither is required, so they are plain
      // values, taken from the environment of whoever runs `cf dev` or
      // `cf deploy`. Left unset, there is no GitHub sign-in.
      VIBE_GITHUB_CLIENT_ID: bindings.text(process.env["VIBE_GITHUB_CLIENT_ID"] ?? ""),
      VIBE_GITHUB_SIGNUP: bindings.text(process.env["VIBE_GITHUB_SIGNUP"] ?? ""),
    },
  }),
});
