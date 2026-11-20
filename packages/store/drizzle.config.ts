import { defineConfig } from "drizzle-kit";

// `bun run db:generate` diffs the schema against the last snapshot and writes
// the next SQL migration. `cf d1 migrations apply` runs them against D1.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
