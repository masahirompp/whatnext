# whatnext

A terminal list of your parallel Claude Code sessions, ordered by which one to touch next — with the reason shown on every row.

When several sessions are waiting at once, whatnext ranks them by how much it costs to leave them waiting versus how cheap they are to unblock (a permission prompt first, a finished task to review later). Pick a row to attach, detach to come back to the list.

> **Status: 0.x — expect breaking changes without notice.**

## Principles

- **Reads state only from `claude agents --json`.** No private files, no screen scraping.
- **Writes nothing and keeps no state.** Closing whatnext loses nothing; sessions started elsewhere show up too. Your settings are never modified.
- **Never answers for you.** No input injection or auto-approval — you attach and act yourself.

## Usage

```sh
npx @masahirompp/whatnext
```

## Requirements

- Node.js 22 or later
- [Claude Code](https://code.claude.com) (`claude`) and `git`
- Optional: `ghq` (more working-directory candidates), `gh` (PR numbers on rows). Without them, whatnext works the same with less shown.

## Documentation

Design documents are written in Japanese.

- [docs/PRODUCT.md](docs/PRODUCT.md) — spec: ranking rules, display, key operations
- [docs/adr/](docs/adr/) — decisions that hold across rewrites
- [docs/claude-code-behavior.md](docs/claude-code-behavior.md) — observed behavior of `claude` that whatnext relies on
- [CONTEXT.md](CONTEXT.md) — glossary

## Development

This project is rebuilt from scratch in cycles; only the docs above persist. See [CLAUDE.md](CLAUDE.md).

## License

MIT
