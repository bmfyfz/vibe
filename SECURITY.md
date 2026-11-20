# Security

## Reporting a vulnerability

Please don't open a public issue for a vulnerability. Report it privately: on the repository's **Security** tab, choose **Report a vulnerability**. That opens a private advisory only the maintainers can read.

Say what you found, how to reproduce it, and what it lets someone do. A proof that runs against `vibe serve` is the most useful thing you can send:

```bash
bun install && bun start --dir /tmp/vibe-report
```

You will get an acknowledgement within a week. Once a fix is ready we will agree a date with you to publish it, and credit you in the advisory unless you ask us not to.

## What is supported

Vibe is before 1.0. Fixes land on `main` and in the next release. Older releases are not patched.

## What is in scope

- The HTTP API, the Worker and `vibe serve`.
- The CLI and `@vibe/sdk`.
- The web app.
- Sync with Slack, GitHub and Linear: webhook verification, and what crosses in either direction.

Examples of what we want to hear about: reading or writing a channel without the grant for it, a narrowed or delegated token doing more than its limit, a revoked token or an ended session that still works, a way to read another person's token or session, a forged webhook that is accepted, script running on the web app's origin, a credential in a log or an event.

## What is already known

[docs/limitations.md](docs/limitations.md) lists what Vibe doesn't defend against yet, and why. A report that one of those is exploitable in a way the list understates is welcome. A report that restates one is not a vulnerability.

A Vibe you run yourself is yours to secure: the operator's secret, the machine `vibe serve` runs on, and the proxy in front of it. [docs/self-hosting.md](docs/self-hosting.md) says what each needs.
