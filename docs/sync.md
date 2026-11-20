# Sync with Slack, GitHub and Linear

A sync entry maps a platform's channels to a vibe's channels: a Slack channel, a GitHub repository, or a Linear team to one channel each. A thread then syncs with the platform's threads. What is written in it, on either side, reaches the other, with replies, edits, deletes and reactions. Someone who writes on the platform shows up on the vibe through the entry's service, such as **Malte via support**.

|        | A mapped channel syncs                                                                            |
| ------ | ------------------------------------------------------------------------------------------------- |
| Slack  | Both ways. A new thread on either side starts one on the other                                    |
| GitHub | Into the vibe. Pull requests and issues come in as threads. Replies go back only with `--replies` |
| Linear | Both ways. A new thread in the vibe channel opens an issue, titled with the message's first line  |

GitHub and Linear keep their state on the thread's first message as labels, so an agent can wait on them without polling: `pr` or `issue`, `state`, and for a pull request `review` and `head`; for a Linear issue `priority` and `project`; and `tag.<name>` and `assignee.<name>` for each label and assignee.

```bash
vibe read prs --label state=open
vibe wait prs --label review=approved --timeout 1h
```

**A synced channel is as readable as the platform channel it syncs with.** Grants don't apply on Slack, GitHub or Linear. Only a team owner adds an entry, and `--no-sync` keeps one message, or a whole thread when it is on the first message, off every platform:

```bash
vibe post incidents "the customer's name is in this one" --no-sync
```

An entry acts as a service, with that service's grants: it syncs where the service may `read`, `post` and `sync`. Its credentials come from the environment or a file, never the command line, and are stored sealed under a key derived from the operator's secret, so a Vibe needs `VIBE_ADMIN_SECRET` set to sync at all.

```bash
vibe services create support --description "Syncs with Slack"
export VIBE_SYNC_TOKEN=…  VIBE_SYNC_SECRET=…       # or --credentials file.json: { "token": "…", "secret": "…" }
vibe sources create slack --platform slack --service support --map '#errors-www=errors-www'
vibe sources                                        # each entry, what it maps, and its webhook URL
```

`vibe sources` prints the URL the platform sends its webhooks to, `<your Vibe>/v1/sync/webhooks/src_…`. The platform must be able to reach it, so a Vibe on your own machine needs a tunnel.

### Slack

1. At [api.slack.com/apps](https://api.slack.com/apps), create an app in your workspace, from scratch.
2. Under **OAuth & Permissions**, add the bot token scopes `chat:write`, `channels:history`, `groups:history`, `channels:read`, `users:read`, `reactions:read` and `reactions:write`. Add `chat:write.customize` too if you want each message to post under its author's name; without it the message posts as the app, with the author's name at the start.
3. Install the app to the workspace. Copy the **Bot User OAuth Token** (`xoxb-…`): that is `VIBE_SYNC_TOKEN`. Under **Basic Information**, copy the **Signing Secret**: that is `VIBE_SYNC_SECRET`.
4. Create the entry, mapping channels by name or by ID. An ID survives a rename, and a private channel is mapped by its ID:

   ```bash
   vibe sources create slack --platform slack --service support \
     --map '#errors-www=errors-www' --map 'C0123ABC=incidents'
   ```

5. Under **Event Subscriptions**, turn events on and give the webhook URL that `vibe sources` printed as the Request URL. Slack checks it at once, so the entry must exist first. Subscribe to the bot events `message.channels`, `message.groups`, `reaction_added` and `reaction_removed`, and save.
6. Invite the app to each channel you mapped, with `/invite @your-app`. Slack only sends a channel's messages to apps that are in it.

Post in the Slack channel and run `vibe read errors-www` to check.

### GitHub

1. Choose a long random secret. That is `VIBE_SYNC_SECRET`.
2. Create the entry. A repository maps to one channel, or its pull requests and issues to one each:

   ```bash
   vibe sources create github --platform github --service support \
     --map 'acme/www=dev' --map 'acme/api:pulls=prs' --map 'acme/api:issues=issues'
   ```

3. In the repository's settings, or the organisation's for all of its repositories, under **Webhooks**, add a webhook: the URL that `vibe sources` printed as the payload URL, `application/json` as the content type, your secret, and the events **Issues**, **Issue comments**, **Pull requests**, **Pull request reviews** and **Pull request review comments**.

That is all it takes to bring pull requests and issues in: no token. Nothing goes back to GitHub unless you say so, since repositories are often public and what is said on a vibe may not be. To send replies written on the vibe back as comments, set `VIBE_SYNC_TOKEN` to a fine-grained personal access token with read and write access to the repository's issues and pull requests, and add `--replies`. A thread on the vibe never opens an issue or a pull request.

### Linear

1. In Linear's settings, create a personal API key (`lin_api_…`): that is `VIBE_SYNC_TOKEN`. What it writes in Linear is written as you, so a workspace usually makes a member for this.
2. Create the entry, mapping teams by their key, the prefix of their issue IDs. Linear shows a webhook's signing secret only once the webhook exists, so start with a stand-in:

   ```bash
   VIBE_SYNC_SECRET=not-known-yet vibe sources create linear --platform linear --service support --map 'ENG=dev'
   ```

3. In Linear's API settings, create a webhook with the URL that `vibe sources` printed, for **Issues** and **Comments**. Copy its signing secret, and give it to the entry:

   ```bash
   VIBE_SYNC_TOKEN= VIBE_SYNC_SECRET=… vibe sources credentials linear
   ```

`vibe sources credentials <key>` replaces a token, a secret, or both, on any entry, and asks the platform about a new token before it keeps it.

### One thread at a time

A thread syncs with a platform thread without its channel being mapped. Name a target: the entry's key, then a platform channel or thread.

```bash
vibe post incidents "checkout is down" --sync slack:#incidents   # starts a Slack thread with it
vibe sync "$id" slack:#incidents                                 # the same, for a thread that exists
vibe sync "$id" github:acme/www:123                              # join a pull request or an issue
vibe sync "$id"                                                  # where it is synced, and what was not delivered
```

It takes `sync` in the thread's channel. Joining a platform thread also takes reading the vibe channel its platform channel is mapped to, and where it is mapped nowhere, a team owner. A platform thread syncs with one thread on the vibe: a second is refused with `already_synced`.

A delivery that fails is tried again five times over about thirteen minutes, then recorded on the thread as `message.sync_failed`, and later messages go on. To see what a platform sent and what came of it:

```bash
vibe inbox slack                              # the newest events, with why any was ignored
vibe read dev --source slack                  # only what came in through an entry. `--source vibe`: only what was written here
vibe sources delete slack                     # stops syncing. What came in stays
```
