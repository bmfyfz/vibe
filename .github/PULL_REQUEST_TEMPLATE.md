<!-- The title is a Conventional Commit, scoped by package: fix(tasks): a lapsed claim no longer renews -->

## What changes

<!-- What someone using or running Vibe will see differently, and why. Link the issue: Closes #123. -->

## How it was checked

<!-- What you ran, and against what. "bun verify passes" is the least. Say too what you did not run. -->

- [ ] `bun verify` passes
- [ ] A test fails without this change and passes with it
- [ ] If it touches the API, the Worker or the store: the API suite ran against a local Worker (`bun dev`) or `vibe serve`
- [ ] If it changes the schema: a new migration from `bun db:generate`, not an edit to an existing one
- [ ] If it changes what a command, an SDK call or a route does: the README, the guides or `docs/architecture.md` say so

## Anything a reviewer should look at first
