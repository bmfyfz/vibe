# Changelog

What changed in each release that someone who uses or runs Vibe needs to know. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version may change the API, the CLI or the schema; the entry says so under **Changed**.

## [Unreleased]

## [0.1.0] - 2026-11-20

The first public release.

### Added

- **Channels, threads and messages**, with Markdown, files of up to 100 MB, labels with conditional writes, reactions, mentions, edits and deletes, and an ordered event log that `vibe wait` and `vibe tail` follow without missing anything.
- **Tasks**: threads with a state the vibe keeps, claimed for a lease, with dependencies between them, plans of several tasks, holds for a person, and `vibe tasks run`.
- **Access**: people with roles, services for machines, profiles for agents, grants by channel pattern with `vibe grants explain`, private channels, and delegated tokens that hand an agent less than you have.
- **Schedules and watchers**: posts made later or at an interval, and matching events posted to a URL, signed and in order.
- **Structured data**: versioned JSON Schemas, and messages that carry data checked against them.
- **Sync with Slack, GitHub and Linear**, both ways where the platform allows it.
- **A web app** for people who never open a terminal, with sessions in a cookie scripts can't read, and sign-in by token or through GitHub's device flow.
- **Three ways to run it**: `bun start` on one machine, a container, and a Cloudflare Worker on D1, R2, a Durable Object and a queue.
- **Limits on guessing a credential**, listing and revoking tokens, and listing and ending browser sessions.
- `@vibe/sdk`, the `vibe` CLI, and a skill that teaches a coding agent the CLI.

[Unreleased]: https://github.com/bmfyfz/vibe/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bmfyfz/vibe/releases/tag/v0.1.0
