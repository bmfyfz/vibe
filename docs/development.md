# Working on Vibe

How to run it while you change it, how to test a change, and what is where. [CONTRIBUTING.md](../CONTRIBUTING.md) says what a change needs before it can merge, and [the engineering principles](engineering-principles.md) say how the code is meant to be written.

You need [Bun](https://bun.com) 1.4 or later and Git. For `bun check`, `bun verify`, `bun dev` and a deploy you also need [Node.js](https://nodejs.org) 22.18 or later: Cloudflare's `cf` CLI, which installs with the project, type-checks and runs the Worker, and doesn't run on Bun. `bun start` and `bun test` need only Bun.

## Commands

| Command               | What it does                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `bun fmt`             | Formats everything                                                                                                            |
| `bun lint`            | Lints with Biome                                                                                                              |
| `bun check`           | Type-checks the workspace, then the Worker against Cloudflare's runtime types                                                 |
| `bun test`            | Runs every test in-process, on SQLite and an in-memory blob store                                                             |
| `bun verify`          | All four                                                                                                                      |
| `bun web:build`       | Builds the web app into `apps/web/dist`, where `vibe serve`, `bun dev` and a deploy take it from                              |
| `bun web:dev`         | Runs the web app under Vite, with the API proxied from `VIBE_URL`                                                             |
| `bun db:generate`     | Writes the next SQL migration after you change `packages/store/src/schema.ts`, and the list of them that `vibe serve` applies |
| `bun start`           | Serves a Vibe from this checkout, building the web app first when it is missing                                               |
| `bun run cli:install` | Compiles the CLI and links it onto your PATH                                                                                  |
| `bun run labels`      | Makes a GitHub repository's issue labels match `.github/labels.json`, through `gh`. `--dry-run` shows what it would do        |

While you work on the CLI, run it from source: `bun vibe <command>`, or `alias vibe="bun $PWD/apps/cli/src/main.ts"`.

## Run the Worker locally

`bun start` runs the app on Bun and SQLite. To run it as it runs on Cloudflare:

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars
bun db:migrate:local
bun dev
```

`bun dev` serves the API on http://localhost:8787, with D1, R2, the Durable Object and the queue simulated under `apps/api/.cloudflare/`. There you add yourself with the operator's secret:

```bash
export VIBE_URL=http://localhost:8787
vibe admin user create ada --admin-secret dev-admin-secret --save
```

To work on the web app, `bun web:dev` runs it under Vite with the API proxied from `VIBE_URL`, `http://127.0.0.1:7473` unless you set it.

## Run the suite against a running Vibe

`bun test` runs everything in process. The black-box API suite in `apps/api/test` also runs against any Vibe that is up, which is how the D1 and R2 adapters, the queue and the live socket are checked:

```bash
VIBE_TEST_URL=http://localhost:8787 VIBE_TEST_ADMIN_SECRET=dev-admin-secret bun test apps/api
```

Run `bun db:migrate:local` first whenever a migration was added. The same suite checks `vibe serve`, which migrates its own database when it starts:

```bash
VIBE_ADMIN_SECRET=serve-admin-secret vibe serve --dir /tmp/vibe-under-test --port 7480 --address-header cf-connecting-ip
VIBE_TEST_URL=http://127.0.0.1:7480 VIBE_TEST_ADMIN_SECRET=serve-admin-secret bun test apps/api
```

The tests of the [limits on guessing](self-hosting.md#limits-on-guessing) use a budget up on purpose, each from an address of its own, sent in `CF-Connecting-IP`. A Worker run locally takes that header from the client, and so does `vibe serve` when it is started as above. Against a Vibe that takes the address from somewhere else, set `VIBE_TEST_ADDRESSED=false` and those tests are skipped, so they don't lock out the rest of the suite. Against a deployment they are skipped without being told.

Run it against a real runtime before you call a change to the API, the Worker or the store done. In-process tests run the app compiled ahead of time, and the Worker can't.

## Migrations

The schema is one file, `packages/store/src/schema.ts`. After changing it, `bun db:generate` writes the next SQL migration and the list of them that `vibe serve` applies. Never edit a migration that exists: it has been applied to databases you can't see.

`bun db:generate` takes drizzle-kit's name for a migration. To choose one, run `bunx drizzle-kit generate --name <name>` in `packages/store`, then `bun run --filter @vibe/store db:embed`.

## Layout

```
apps/api         the Worker: D1, R2, the VibeHub Durable Object, the delivery queue and cron under
                 the app, and the black-box suite
apps/cli         the vibe command, and vibe serve
apps/web         the web app: Vite and React, over @vibe/sdk
packages/kernel     errors, IDs, channel paths, and the ports the contexts share
packages/server     the HTTP API as an Elysia app, and the one place that wires the contexts
                    together. It knows no runtime: the Worker serves it, and so does Bun
packages/store      Drizzle schema, migrations, and the D1, SQLite, R2, directory and memory adapters
packages/contracts  Zod schemas for every request and response
packages/identity   users, services, tokens, roles, profiles, grants, delegated tokens, sign-in
packages/messaging  vibes, channels, threads, messages, labels, reactions, mentions, attachments,
                    schemas and the data that matches them
packages/tasks      tasks: claims and leases, queues, plans, holds
packages/automation schedules: posts made later, as whoever scheduled them. Watchers: events
                    posted to a URL
packages/sync       sync entries, and the Slack, GitHub and Linear adapters: webhooks in,
                    deliveries out, platform users as actors
packages/activity   the event log, cursors, filters, long-poll, and the poke after a commit
packages/sdk        the client the CLI is built on
skills/vibe         SKILL.md, which teaches a coding agent the CLI
```

Each context has three layers, `domain/`, `application/` and `infrastructure/`, and can import only what its `package.json` declares. How they fit together is in [architecture.md](architecture.md).

## Releasing

1. Move what is under **Unreleased** in `CHANGELOG.md` to a new version, and set that version in the root `package.json`.
2. `bun verify`, and the API suite against a local Worker and against `vibe serve`.
3. Tag the commit `v<version>` and push the tag.
