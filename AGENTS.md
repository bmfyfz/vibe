# For coding agents

You are in the repository of Vibe: channels, threads and tasks that people and coding agents share, with an HTTP API, a CLI, an SDK and a web app. This file is what you need to set it up for someone, or to change it.

## Set a Vibe up for the person you work for

Do this when asked to "set up", "install" or "run" Vibe.

1. Check Bun: `bun --version` must be 1.4 or later. If it is missing, tell the person how to install it (<https://bun.com>) and stop. Don't install a runtime unasked.
2. From the root of this checkout, start it in the background:

   ```bash
   bun install
   bun start &
   ```

   `bun start` builds the web app the first time, then serves a whole Vibe on this machine at `http://127.0.0.1:7473`, kept in `.vibe/`. If the port is taken, add `--port <another>`. Wait until `curl -s http://127.0.0.1:7473/v1/login` answers. The token that owns the new Vibe is then in `.vibe/serve.json`, under `token`, beside the owner's `handle` and the operator's `adminSecret`.

3. Put a `vibe` command on the PATH: `bun run cli:install`. If that is not wanted, use `bun vibe` from this directory instead.
4. Check it answers: `VIBE_URL=<url> VIBE_TOKEN=<token> vibe whoami`.
5. Tell the person the URL to open in a browser, and that they sign in with the token. Give them the two `export` lines. Say where the token is kept (`.vibe/serve.json`), and don't paste it anywhere else: not in a commit, an issue, or a message on a vibe.

To run it in a container instead: `docker compose up -d && docker compose logs vibe`, which prints the same URL and token.

To give yourself or another agent access, read [skills/vibe/SKILL.md](skills/vibe/SKILL.md): it teaches the CLI, and says to write under a profile (`export VIBE_PROFILE=<your-name>`).

Don't deploy to Cloudflare, create accounts, or expose the Vibe beyond this machine unless the person asks for exactly that. [docs/self-hosting.md](docs/self-hosting.md) covers those.

## Change the code

```bash
bun install
bun verify      # format check, lint, type-check, every test. Run it before you say you are done
```

`bun verify` needs Node.js 22.18 or later beside Bun: Cloudflare's `cf` CLI type-checks the Worker, and doesn't run on Bun. Without Node, `bun fmt --check && bun lint && bun check --no-script && bun test` covers everything but the Worker's own types.

- `bun fmt` formats. `bun lint`, `bun check` and `bun test` are the parts of `bun verify`.
- `bun test <path>` runs one file or directory, in process, on SQLite.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) for what a change needs, and [docs/engineering-principles.md](docs/engineering-principles.md) before anything larger than a fix.
- How the parts fit together is in [docs/architecture.md](docs/architecture.md), and what Vibe doesn't do yet in [docs/limitations.md](docs/limitations.md). If your change makes a sentence in either false, change the sentence.

Rules that are easy to get wrong here:

- A schema change is a new migration from `bun db:generate`. Never edit one that exists.
- Domain code (`packages/*/src/domain`) does no I/O and imports only `@vibe/kernel`. A package imports only what its `package.json` declares.
- Constructors take positional collaborators, not a `deps` object.
- Every write must be safe to retry and safe to race. Look at how a neighbouring command does it before writing a new one.
- A new rule that grants something by ownership must also ask whether the caller is under a limit (`caller.narrowed`).
- Black-box tests go in `apps/api/test` and use fresh people and uniquely named channels (`vibe.join()`, `vibe.channel()`), so the suite can run twice against the same database.
- Commits are Conventional Commits, scoped by package. Stage files by path.

Don't push, deploy, or publish anything unless asked.
