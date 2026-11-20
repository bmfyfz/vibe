# Engineering principles

The rules Vibe's code is written by. Each one says what to do, why, and where Vibe does it. Read it before a change larger than a fix: a review will hold the change to these.

Two kinds of rule are mixed here on purpose. Most are general. A few exist because of the platform (D1 has no interactive transactions; Workers refuse code generated from strings). Those are marked **Platform**.

## 1. Stack

| Concern                                                | Choice                                                             | Note                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Runtime, package manager, tests, formatter, type-check | Bun (`bun test`, `bun fmt`, `bun check`)                           | One tool instead of five                                            |
| Lint                                                   | Biome, linter only                                                 | Bun has no linter. Formatter and import sorting stay with `bun fmt` |
| Language                                               | TypeScript at maximum strictness                                   | See section 11                                                      |
| HTTP                                                   | Elysia                                                             | Routes validate with the shared Zod schemas                         |
| Validation and API types                               | Zod, in a `contracts` package                                      | One definition for server, client and read models                   |
| Database                                               | Drizzle: schema, generated migrations, queries                     | Over SQLite on D1                                                   |
| Platform                                               | Cloudflare Workers, D1, R2, Durable Objects, Queues, cron triggers | Driven by the `cf` CLI and `cloudflare.config.ts`                   |

**One command checks everything.** `bun verify` runs format check, lint, type-check and tests. If a check isn't in that command, it will stop being run.

**Pin prerelease tooling exactly, and list it as a risk.** `cf` and its Vite plugin are release candidates. They are pinned to exact versions and named among the [known limitations](limitations.md).

**Read the tool before trusting memory of it.** New tools change. Before you write configuration for one, read its type declarations as installed, not what you remember of its documentation.

## 2. Monorepo layout

```
apps/
  api/          the deployable: routes, and the one place that wires everything together
  cli/          a thin command-line client over the SDK
packages/
  kernel/       shared kernel: errors, IDs, clock, and the ports contexts share
  contracts/    every request and response as Zod schemas
  store/        schema, migrations, and adapters for each backend
  identity/     one package per bounded context …
  messaging/
  tasks/
  activity/
  sdk/          the client the CLI and the tests are built on
```

**One package per bounded context.** A context's boundary is its `package.json`: it can import only what it declares.

**Let the installer enforce the boundaries.** Bun's isolated installs (`linker = "isolated"` in `bunfig.toml`) give each package only its declared dependencies. An undeclared import fails to resolve instead of working by accident.

**Packages export source.** `"exports": { ".": "./src/index.ts" }`. No build step between packages, and one type-check for the workspace.

**Apps compose; packages don't know apps exist.** Nothing imports from `apps/*`. When a second app needs what the first one wires, move the wiring into a package.

**One file knows the platform.** `apps/api/src/worker.ts` is the only file that imports Cloudflare. It hands a database and a blob store to an app that sees two interfaces. The same app runs in a test on SQLite and memory.

## 3. Modularity

**Three layers in every context, with one dependency rule.**

```
domain/          aggregates, value objects, domain events, domain errors. Imports the kernel only
application/     commands, queries, and the ports they need
infrastructure/  adapters: repositories and read models
index.ts         the public surface, and a create<Context>() function that wires it
```

Domain code does no I/O. Application code talks to ports. Only infrastructure knows the database.

**Ports are named for what the caller needs.** `ThreadRepository.isAttachmentTaken(error)`, `EventLog.isVersionConflict(error)`. The application asks a question in its own terms; the table and index names stay in infrastructure.

**Constructors take their collaborators as plain arguments.** `constructor(private readonly threads: ThreadRepository, private readonly clock: Clock)`, never a single `deps` object. The signature is the dependency list.

**Wire in one place.** Each context exports `createMessaging({ db, begin, … })`. The app's composition root calls them in dependency order and passes one context's ports to the next.

**Contexts meet through narrow, named seams.** Three were needed:

- An interface one context publishes and others call: `Authorizer.require(caller, permission, resource)`.
- A method on an aggregate for a neighbour's state: Tasks records each change with `Thread.note(…)`, so a task change takes the thread's next version without Messaging knowing what a task is.
- A hook called before commit: a `ThreadFollower` is told of a change to a thread and may write alongside it, in the same transaction. That is how deleting a message cancels its task.

**Reads skip the aggregates.** Queries are read models in infrastructure that return the API's own shapes. Commands go through aggregates; lists and feeds don't pay for them.

**The shared kernel stays small.** It holds what three or more contexts must agree on: the error type, IDs, the clock, a channel path, the unit-of-work and event-log ports. Anything one context owns stays in that context.

## 4. Domain modeling

**The aggregate is the unit of consistency.** Pick it by asking what must never be seen half-changed. In Vibe it is the thread: messages, labels, reactions and task state in one thread are all ordered by the thread's version.

**Domain methods are pure and told the time.** `thread.reply({ id, actorId, text, now })`. IDs and `now` come in as arguments; nothing reads a clock or generates randomness inside. Tests are then plain function calls.

**Decide, then record.** A method checks its rules, changes state, and appends a domain event. The handler pulls the events and stores them. A method that changes nothing records nothing, and the handler commits nothing.

**Parse at the boundary into types that can't be wrong.** `parseChannelPath(input)` returns a branded `ChannelPath` or throws `invalid_channel`. Past that line nobody re-validates.

**Limits are named constants in the domain.** `MAX_TEXT_LENGTH`, `MAX_LEASE_MS`, `MAX_TASKS_PER_WRITE`. The error message is built from the constant.

**Let the domain say what it doesn't know.** A task can't know whether the tasks it waits for have completed, so commands are told (`unmet: boolean`) and the doc comment says so. Don't smuggle a repository into an entity.

## 5. Consistency and concurrency

Written for a system where many agents write at once and every write may be retried.

**One command, one atomic write, N events.** A handler loads state, runs the domain method, and commits the state, its projections and its events together. There is no second write that could fail after the first.

**Optimistic locking through a uniqueness rule.** Every event row carries `(thread_id, thread_version)` under a unique index. A write computed from stale state reuses a version, violates the index, and the whole batch rolls back.

**On a lost race, load again and decide again.** Never patch the failed write. The loop is the same everywhere:

```ts
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const thread = await threads.findByMessage(vibeId, messageId); // fresh state
  decide(thread, clock.now()); // domain rules, may throw
  const events = thread.pullEvents();
  if (events.length === 0) return { changed: false };

  const uow = begin();
  eventLog.append(uow, toRecords(thread, events));
  threads.save(uow, thread, events);
  try {
    await uow.commit();
    return { changed: true };
  } catch (error) {
    if (!eventLog.isVersionConflict(error)) throw error; // anything else is a real failure
  }
}
throw writeConflict();
```

The second attempt either succeeds or fails with the true reason (`task_claimed`, `label_conflict`), because it is decided from what the winner left.

**Use a primary key for "exactly one".** A file joins one message because `attachment_id` is the primary key of the link table. A claim, an idempotency key and a grant revision work the same way. The database refuses the second writer; no code has to notice.

**Idempotency keys are written in the same transaction as the thing they protect.** A retry finds the key and returns the earlier result. The same key for something else is refused (`duplicate_id`).

**Offer conditional writes.** `reply --after <id>`, `label --if state=open`, `edit --if-revision 3`. The check and the change are one write, so callers never need a lock.

**Make time lazy.** A lease that has passed is over because every reader compares it with the clock, not because a timer fired. A sweep only tidies: it updates labels and emits events for what is already true. Correctness never waits on a scheduler.

**Follow-ups that may fail run after the commit, and something converges them.** Completing a task commits first, then readies what waited for it. If that second step fails, the completion stands and the sweep retries.

**The event log is the outbox.** Every consumer (feeds, watchers, sync) keeps its own cursor into one ordered log. A lost notification delays delivery; it cannot lose it.

**Cursors are opaque, and reads are "seen twice, never missed".** Read the cursor before the data it covers. Anything that lands in between appears in this read and again after the cursor.

**Platform: D1.** There are no interactive transactions, only an all-or-nothing batch, which is why every command is one batch. D1 has a single writer, so an autoincrement sequence is commit order with no gaps. A statement takes at most 100 bound parameters, which caps multi-row inserts and the number of filters a query accepts.

## 6. Errors

**One error type the caller can act on.**

```ts
class DomainError extends Error {
  constructor(
    readonly kind: "invalid" | "unauthorized" | "forbidden" | "not_found" | "conflict" | …,
    readonly code: string,   // stable and machine-readable: "newer_message", "claim_lost"
    message: string,         // one sentence for a person
    readonly hint?: string,  // what fixes it, when something does
  ) { super(message); }
}
```

**The domain says what kind of failure it is; the adapter picks the status.** `kind` maps to 400, 401, 403, 404, 409 in one table in the HTTP layer. No domain code mentions HTTP.

**Codes are an API.** Clients branch on `code`, so codes are named, documented and never reworded. Messages and hints can improve freely.

**Each context declares its errors in one file.** `domain/errors.ts` holds small factories (`taskClaimed()`, `invalidNeeds(message)`). The wording lives in one place and call sites read as prose.

**An error never tells the caller more than a read would.** What you can't read is `not_found`, for reads, for changes and for cursors. `label_conflict` names the label and never its value. Refusing a change must not confirm that the thing exists.

**Validate at the edge with the shared schemas, strictly.** Request bodies are strict objects, so an unknown field is refused. That is how a misspelled `need` can't create a task that waits for nothing. The response names the first field that is wrong.

**Translate storage errors once.** The store turns a driver's constraint error into one kernel type (`ConstraintViolation`). Handlers ask ports what it means. Driver error strings are parsed in exactly one function.

**Unknown errors are logged and hidden.** Anything that isn't a `DomainError` becomes `500 internal` with a fixed message.

**The same shape all the way out.** The SDK throws `VibeError { code, message, status, hint }`. The CLI prints `code: message` and the hint, or one JSON document on stderr with `--json`, and exits `0` for success, `1` for failure or timeout, `2` for a usage error, `130` for Ctrl-C.

**A failure in a courtesy must not fail the request.** Notifying a hub or readying dependents is wrapped, logged and left to the sweep.

## 7. API, SDK and CLI

**Three surfaces, one protocol.** The CLI is thin over the SDK, the SDK is thin over HTTP, and the contracts package types all three.

**Design for a caller that retries and races.** Every write is safe to send twice and safe to send at the same time as another. This is the property agents need most, and it comes from section 5, not from the API layer.

**Scripts are first-class users of the CLI.** `post` prints only the new ID, so `id=$(vibe post dev "…")` works. Every command takes `--json`. `read` and `wait` end by printing the exact command that continues from where they stopped.

**Long waits are short requests in a loop.** A request waits at most 20 seconds on the server and the client repeats it, which stays inside per-invocation limits and survives a dropped connection.

**Asking for more than seems needed is a decision.** Where Vibe is stricter than a caller might expect (claiming a task takes `read` as well as `label`), the design says so and says why.

## 8. Security and access

- **Secrets are shown once and stored as hashes.** Tokens are random and long, so a plain SHA-256 suffices.
- **Compare secrets in constant time.**
- **A name changes attribution, never permission.** An agent's profile gets its own handle and mentions, and exactly the access of the token behind it.
- **A capability stays out of the log.** A task's claim ID is what settles the task. It is returned to the claimant and never written to an event.
- **Access is decided in the domain.** The policy is a pure function over a vibe's grants: easy to test, and it can explain itself (`grants explain`).
- **Uploaded files are served as downloads.** `Content-Disposition: attachment` and `nosniff`, so an uploaded HTML file can't run on the API's origin.
- **Operator routes are separate and off by default.** Without the deployment's secret configured they refuse everyone.

## 9. Persistence

**One schema file, generated migrations.** Tables are defined once in Drizzle; `drizzle-kit generate` writes the SQL; the platform's own tool applies it. Generate migrations last, after rebasing, so two branches don't claim the same number.

**One database type for every runtime.** The store exposes a single Drizzle database over a two-method executor (run one statement; run several atomically), with an executor per backend. Repositories are written once and run on D1 in production and on bun:sqlite in tests.

**A unit of work collects statements; committing is one batch.** Repositories add to it and never commit. The handler commits once.

**Store what is true, compute what is derived.** A task's row says `claimed` with a lease time; "is it claimable" is a comparison at read time.

**Platform: SQLite.** Subtrees are range scans, not `LIKE`, because `_` is legal in a path. JSON functions build nested views in one query instead of N+1.

## 10. Testing and verification

**Domain tests are plain unit tests.** No database and no mocks, because the domain takes its inputs as arguments.

**One black-box suite, two targets.** The API suite drives the real app through the SDK. By default the app runs in-process on SQLite and memory. With `VIBE_TEST_URL` set, the same suite runs against a deployed or locally simulated instance. That is how the real database and blob-store adapters are tested.

**Tests must survive a database that already has data.** Every test uses fresh users and uniquely named channels, so the suite can run against a persistent instance, twice.

**Test the races.** `Promise.all` over five claims of one task and assert exactly one wins. Do the same for a shared idempotency key and for a file two posts want.

**Prove a test can fail.** Break the rule a new test is for, and watch the test fail, before you trust it. A test that passes with the rule broken tests nothing.

**Skip in the open.** What can't be triggered against a remote target (a scheduler) is skipped there by name, and the pull request says how it was checked instead.

**Run it on the real runtime before calling it done.** In-process tests run Elysia compiled, and the Worker runs it uncompiled, where a route option can be silently ignored. Only a run against a local Worker shows the difference.

## 11. Code style

**TypeScript as strict as it goes.** Beyond `strict`: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedSideEffectImports`, `verbatimModuleSyntax`. One shared `tsconfig.base.json`.

**Lint rules that are errors:** unused imports, variables and parameters; non-null assertions; explicit `any`; missing `import type`; `==`.

**Type-check the deployable against its own runtime.** The workspace is checked with Bun's types and the Worker again with Cloudflare's. Shared code that reaches for a Bun-only API fails the second check.

**Comments say why.** What the code does is in the code. A comment earns its place by stating a rule ("a reply takes both: you answer what you can read") or a trap ("`_` is legal in a path, so no `LIKE`").

**Doc comments on every port and public method.** Say what it guarantees and when it throws. The next context is written against those sentences.

**Small files named for what they hold.** `post-message.ts`, `claim-ready.ts`, `drizzle-task-repository.ts`.
