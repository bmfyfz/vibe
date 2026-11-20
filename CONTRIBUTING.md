# Contributing

Thanks for wanting to. This says how to get the code running, what a change needs before it can merge, and where things are.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md). A vulnerability goes through [SECURITY.md](SECURITY.md), not an issue.

## Before you write code

- **A bug:** open an issue with the shortest steps that show it. If you already have the fix, open the pull request and say what it fixes.
- **A feature:** open an issue first. [docs/limitations.md](docs/limitations.md) lists what Vibe doesn't do yet and why, so check whether your idea is there. An hour of agreeing on the shape saves a rewrite.
- **Docs and typos:** just send the pull request.

## Set up

You need [Bun](https://bun.com) 1.4 or later, Git, and [Node.js](https://nodejs.org) 22.18 or later. Node is there for one thing: Cloudflare's `cf` CLI, which installs with the project, type-checks the Worker and runs it locally, and doesn't run on Bun. `bun start` and the tests need only Bun.

```bash
git clone <this repository> vibe && cd vibe
bun install
bun verify        # format check, lint, type-check, every test. A few seconds
bun start         # a Vibe of your own at http://127.0.0.1:7473, to try things against
```

[docs/development.md](docs/development.md) has the rest: running the Worker locally, running the suite against a running Vibe, adding a migration, and what each package holds.

## What a change needs

1. **`bun verify` passes.** It is what CI runs.
2. **A test that fails without the change.** Domain rules get a plain unit test beside the code. Anything a caller can see gets a black-box test in `apps/api/test`, through the SDK. A race gets a test that races: five claims of one task, and exactly one wins.
3. **The API suite against a real runtime**, when you touch the API, the Worker or the store. In-process tests run the app compiled; the Worker runs it otherwise, and has caught bugs the in-process run couldn't. [How](docs/development.md#run-the-suite-against-a-running-vibe).
4. **A migration, not an edit to one**, when the schema changes: `bun db:generate`. Migrations that exist are already applied to people's databases.
5. **Docs that still tell the truth.** A changed command, route or SDK call changes the README or a guide. A changed design decision changes `docs/architecture.md`, and a limitation you remove or add changes `docs/limitations.md`.

## How the code is laid out

One package per bounded context under `packages/`, each with three layers:

```
domain/          aggregates, value objects, errors. No I/O, and imports only the kernel
application/     commands, queries, and the ports they need
infrastructure/  repositories and read models
```

`packages/server` wires them into the HTTP API and knows no runtime. `apps/api` is the Worker, `apps/cli` the command and `vibe serve`, `apps/web` the web app. [docs/engineering-principles.md](docs/engineering-principles.md) is the long form: how commands stay safe to retry and to race, how errors are shaped, what belongs in which layer. Read it before a larger change. A few rules that reviews come back to:

- Constructors take their collaborators as plain arguments, never one `deps` object.
- The domain says what kind of failure it is (`not_found`, `conflict`); only the HTTP layer picks a status.
- An error never tells a caller more than a read would. What you can't read is `not_found`.
- TypeScript stays as strict as `tsconfig.base.json` makes it. No `any`, no non-null assertions.
- Comments say why. Every port and public method says what it guarantees and when it throws.

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), scoped by package, small enough to read:

```
feat(tasks): hold a task whose text was edited by someone else
fix(identity): a revoked token no longer backs the sessions it opened
test(api): two claims of one task, one winner
docs: how to run behind a proxy
```

The body says what changes for someone using Vibe, and why. Keep a pull request to one thing. The template asks how you checked it: say what you ran and what you didn't.

## Licence

Vibe is under the [MIT License](LICENSE). What you contribute is under it too.
