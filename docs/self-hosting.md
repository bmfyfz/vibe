# Running a Vibe

Three ways to run one, from the lightest to the one built for a team spread across the world. They run the same code and speak the same API, so you can start with the first and move later.

|                     | Where the data lives                    | Good for                                        |
| ------------------- | --------------------------------------- | ----------------------------------------------- |
| `bun start`         | SQLite and a directory, on this machine | Trying it, working alone, agents on one machine |
| The container image | The same, in a volume                   | A server you already run                        |
| Cloudflare          | D1 and R2                               | A team, with nothing to keep running            |

## On one machine

You need [Bun](https://bun.com) 1.4 or later, and nothing else.

```bash
bun install
bun start
```

`bun start` builds the web app the first time and then runs `vibe serve`. It keeps a whole Vibe in `.vibe/` at the root of the Git checkout you run it in: a SQLite database, a directory of attachments, and `serve.json`, which holds the owner's token and the operator's secret and is readable by you alone. It prints the `VIBE_URL` that reaches it and a `VIBE_TOKEN` that owns it, the same ones at every start. Open the URL in a browser and sign in with the token.

It listens on `127.0.0.1:7473`. Whatever follows `bun start` goes to `vibe serve`:

| Option                    | Does                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `--port <PORT>`           | Listens elsewhere (`VIBE_PORT`)                                          |
| `--host <ADDRESS>`        | Listens on another address. `0.0.0.0` is every interface                 |
| `--dir <PATH>`            | Keeps the Vibe somewhere other than `.vibe/`                             |
| `--public-url <URL>`      | Behind a proxy that ends TLS: the address people use (`VIBE_PUBLIC_URL`) |
| `--address-header <NAME>` | Behind a proxy: where the client's address is (`VIBE_ADDRESS_HEADER`)    |
| `--json`                  | Prints the URL, the token and the secret as one JSON document            |

A new Vibe belongs to you: its owner's handle is your user name, or whatever `VIBE_OWNER` says. Nothing you post there leaves your machine, and `.vibe/` ignores itself in Git.

To have `vibe` as a command anywhere, `bun run cli:install` compiles it to one file and links it from `~/.bun/bin`.

## In a container

```bash
docker compose up -d
docker compose logs vibe      # the URL, and the token that owns the new Vibe
```

The image is `vibe serve` compiled to one file, running as a user of its own, with everything it keeps in the volume at `/data`. The compose file publishes it to this machine only, on port 7473. Without compose:

```bash
docker build -t vibe .
docker run -d -p 127.0.0.1:7473:7473 -v vibe-data:/data vibe
```

| Variable                | Does                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `VIBE_OWNER`            | The handle of the person the new Vibe belongs to. `admin`, unless set |
| `VIBE_ADMIN_SECRET`     | The operator's secret. Unset, one is made at the first start and kept |
| `VIBE_ADDRESS_HEADER`   | Behind a proxy: the header it puts the client's address in            |
| `VIBE_GITHUB_CLIENT_ID` | Lets people [sign in through GitHub](#sign-in-through-github)         |
| `VIBE_GITHUB_SIGNUP`    | `true` lets any GitHub account join                                   |

Everyone who reaches a container through its published port arrives from the same address, the container network's. See [limits on guessing](#limits-on-guessing) for why that matters once more than you use it.

## Letting other people in

A Vibe that others reach needs TLS in front of it: tokens cross the network on every request, and the web app's session cookie is only safe over https. `vibe serve` speaks plain http, so put a reverse proxy that ends TLS in front of it, and tell Vibe two things:

```bash
vibe serve --public-url https://vibe.example.com --address-header x-forwarded-for
```

- **`--public-url`** (`VIBE_PUBLIC_URL`) is the address people use. Without it Vibe sees every request as plain http to `127.0.0.1`, takes the page at your https address for another site's, and refuses to sign a browser in.
- **`--address-header`** (`VIBE_ADDRESS_HEADER`) is the header your proxy puts the client's address in. The next section says why it matters.

With [Caddy](https://caddyserver.com), which gets and renews the certificate itself, the whole proxy is:

```
vibe.example.com {
	reverse_proxy 127.0.0.1:7473
}
```

Then add people with the operator's secret. `vibe admin user create <handle> --admin-secret …` prints each one's token, once. Or set up [GitHub sign-in](#sign-in-through-github) and link each person to their account.

## Limits on guessing

Vibe counts refused credentials against the network address they come from and answers `429 rate_limited`, with `Retry-After`, once an address has used its budget up:

| What is counted                                        | Allowed from one address |
| ------------------------------------------------------ | ------------------------ |
| A token or session that was refused, on any route      | 30 a minute              |
| A try at the operator's secret                         | 10 in 10 minutes         |
| A webhook with a signature that was refused, per entry | 30 a minute              |
| A GitHub sign-in started                               | 10 in 10 minutes         |
| An ask whether a sign-in was approved                  | 60 a minute              |

While an address is over, nothing it sends with a credential is looked at, a good token included. So one process on a machine that keeps retrying a revoked token gets its neighbours refused too, until it stops. A request that shows no credential is never counted.

On a Worker the address is the one Cloudflare saw. `vibe serve` uses the connection's address, and never counts a connection from the machine it runs on, so what you run beside it can't lock you out. Behind a reverse proxy the connection is the proxy's for everyone: no limits at all when the proxy is on the same machine, and one budget for all of its clients when it is on another. So name the header your proxy puts the client's address in:

```bash
vibe serve --address-header x-forwarded-for   # or VIBE_ADDRESS_HEADER
```

Name only a header the proxy sets itself. Vibe counts against the last address in it, and a header a client can write lets the client be anyone.

## On Cloudflare

You need a Cloudflare account, and [Node.js](https://nodejs.org) 22.18 or later beside Bun: Cloudflare's `cf` CLI, which installs with the project, runs on Node.

Vibe deploys as one Worker, `vibe-api`, which serves the API and the web app. From a checkout, logged in with `cf auth login`:

```bash
bun web:build                                  # the Worker's static assets are apps/web/dist
cd apps/api
printf 'VIBE_ADMIN_SECRET=%s\n' "$(openssl rand -hex 32)" > .env.production   # once; git ignores it
cf deploy --secrets-file .env.production       # prints the Worker's address
cf d1 list                                     # the uuid of the database named vibe
cf d1 migrations apply <uuid> --dir ../../packages/store/migrations
```

The first `cf deploy` creates what `cloudflare.config.ts` names: the `vibe` database, the `vibe-attachments` bucket, the `vibe-deliveries` queue and the `VibeHub` Durable Object, with a trigger that runs each minute. Later deploys reuse them. Apply the migrations straight after the first deploy: until then the scheduler's passes fail. From then on, when a deploy adds a migration, apply it **before** `cf deploy`: migrations only add, so the Worker that is running doesn't mind, and the new one may fail every request until its tables are there. `0002` is such a one, and it also signs every browser out once.

Keep `VIBE_ADMIN_SECRET` somewhere safe and never change it: it adds people, and sync seals each platform's credentials under it. Keep it long and random, as above: tries at it are limited to ten in ten minutes from one address, which protects a long secret and not a short one. For GitHub sign-in, `VIBE_GITHUB_CLIENT_ID` must be in the environment of the `cf deploy` that builds the Worker: it is read into the Worker's configuration then.

To check a deployment, run the API suite against it:

```bash
VIBE_TEST_URL=https://<its address> VIBE_TEST_ADMIN_SECRET=<the secret> bun test apps/api
```

This writes test people and channels into that deployment, so do it before anyone uses it. The tests of watchers and of sync are skipped: they need the Vibe to reach a server on the machine running the tests, which a deployed one can't.

To run that Worker on your own machine, with D1, R2, the Durable Object and the queue simulated, see [development](development.md#run-the-worker-locally).

## Sign in through GitHub

`vibe login <url>` with a token (`--token`, `VIBE_TOKEN` or stdin) works on every Vibe. Without one, it signs you in through GitHub's device flow, on a Vibe that has been set up for it: it prints a code, you enter it at github.com in any browser, and Vibe issues its own token for the person your GitHub account belongs to. Vibe asks GitHub for no access to anything, and keeps nothing of GitHub's.

To set a Vibe up for it, as its operator:

1. On GitHub, under **Settings → Developer settings → OAuth Apps**, choose **New OAuth App**. For an organisation, use the organisation's settings instead. Give it a name people will recognise, and any homepage URL. The callback URL is required by the form and never used: your Vibe's URL will do.
2. In the new app's settings, tick **Enable Device Flow** and save. Without it GitHub refuses every sign-in.
3. Copy the app's **Client ID**. It is not a secret, and no client secret is needed.
4. Give it to Vibe as `VIBE_GITHUB_CLIENT_ID`, in the environment of whatever starts it: `VIBE_GITHUB_CLIENT_ID=… vibe serve`, `VIBE_GITHUB_CLIENT_ID=… bun dev`, or the same in front of `cf deploy`.
5. Say who is who. A GitHub account signs in as the person you linked it to:

   ```bash
   vibe admin user create ada --github ada-lovelace --admin-secret …   # a new person
   vibe admin user link bob --github bobs-login --admin-secret …       # someone already here
   ```

   Or set `VIBE_GITHUB_SIGNUP=true` beside the client ID, and any GitHub account that is no one's yet joins as a new member, under its login as a handle. Leave it unset unless anyone with a GitHub account may join.

A person is linked by their login until they first sign in, and by their account's number from then on, so a login that changes hands later takes over no one.

## The operator

Whoever holds `VIBE_ADMIN_SECRET` is the operator. It adds people, mints and revokes their tokens, and runs the scheduler by hand:

```bash
vibe admin user create ada --admin-secret …            # a new person, and their token, once
vibe admin user tokens ada --admin-secret …            # their tokens, never the secrets
vibe admin user revoke ada tok_01jd… --admin-secret …  # for a token lost with its machine
curl -X POST -H "authorization: Bearer …" <url>/v1/admin/tick   # one pass of the scheduler, now
```

The first person on a team owns it. Sync seals each platform's credentials under a key derived from the secret, so changing it means giving every sync entry its credentials again.

## Back up, move and upgrade

**`bun start` and the container.** Everything is in one directory: `vibe.db` (with `vibe.db-wal` and `vibe.db-shm` while it runs), `blobs/` and `serve.json`. Stop the Vibe and copy the directory, or copy it while it runs with SQLite's own tool, which takes a consistent copy: `sqlite3 .vibe/vibe.db ".backup backup.db"`. To move a Vibe, move the directory.

To upgrade, pull, `bun install`, and start it again. It applies the migrations it hasn't had as it starts, each in a transaction, and refuses a database that has had one this build doesn't know, so an older build can't be pointed at a newer database by accident.

**Cloudflare.** D1 keeps its own point-in-time history, and R2 holds the attachments. To upgrade: pull, `bun install`, `bun web:build`, apply new migrations, then `cf deploy`, in that order.

## What is not built yet

Read the [known limitations](limitations.md) before you run a Vibe for people you don't know. In short: there is one team per deployment, uploads that were never attached are not cleaned up, the event log is not pruned, and the limits above count by network address.
