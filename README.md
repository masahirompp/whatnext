# whatnext

A terminal list of your parallel Claude Code sessions, ordered by which one to touch next — with the reason shown on every row.

When several sessions are waiting at once, whatnext ranks them by how much it costs to leave them waiting versus how cheap they are to unblock (a permission prompt first, a finished task to review later). Pick a row to attach, detach to come back to the list.

> **Status: 0.x — expect breaking changes without notice.**

## Principles

- **Ranks sessions from `claude agents --json` alone.** No screen scraping. To show what each session is doing and how long it has waited, whatnext also reads hook events from sessions it started and, for other sessions, Claude Code's own conversation transcripts (`~/.claude/projects`) — read-only. Account usage comes from `claude`'s own `/usage`, which calls no model.
- **Sessions whatnext starts send their context size (OpenTelemetry) and hook events to whatnext on 127.0.0.1:14318, only while whatnext is running.** Nothing leaves your machine and nothing is stored. Rows are still ranked from `claude agents --json` alone.
- **Keeps almost no state.** Sessions keep running after you quit whatnext, and sessions started elsewhere show up too. Your settings are never modified. The only file whatnext writes is `~/.local/state/whatnext/state.json` (or under `$XDG_STATE_HOME`), which keeps your holds and wait-for links across restarts.
- **Never answers for you.** No input injection or auto-approval — you attach and act yourself.

## Usage

```sh
npx @masahirompp/whatnext
```

To see a session's workbench shell next to it, split your terminal (e.g. `cmd+d` in Ghostty) and run this in the new split. It follows the session you are looking at; close the split when you no longer need it. In Ghostty, `ctrl+q ctrl+w` on a session (or `w` in the list) opens this split for you (or moves to it if it is already open).

```sh
npx @masahirompp/whatnext workbench
```

Keys in the list:

| Key | Action |
| --- | --- |
| `↑` `↓` | Select a row |
| `Enter` | Attach to the session (or show where an interactive session runs) |
| `n` | Start a new session |
| `Ctrl+X` | Stop the session; press again within 2s to delete it |
| `h` | Put the session on hold (or bring it back) |
| `f` | Choose the sessions this one waits for |
| `w` | Create the session's workbench shell |
| `e` | Open the session's directory or PR in VS Code, GitHub or vscode.dev |
| `r` | Refresh |
| `q` | Quit (asks first if something is still running in a workbench) |

While attached, `ctrl+q` followed by the same letter with ctrl held does the same thing (`ctrl+q ctrl+l` goes back to the list, `ctrl+q ctrl+j` moves to the next session). The keys are shown at the bottom of the session's screen.

## Requirements

- Node.js 22 or later
- [Claude Code](https://code.claude.com) (`claude`), `git`, and `tmux` (tested with 3.7c) (whatnext runs the list, sessions and per-session workbench shells in its own tmux server; your tmux config is not touched. Closing the terminal window leaves whatnext running — run it again to come back to the same list. Quitting whatnext closes the workbench shells — it asks first if something is still running)
- Optional: `ghq` (more working-directory candidates), `gh` (PR numbers on rows, and opening those PRs). Without them, whatnext works the same with less shown.

## Documentation

Design documents are written in Japanese.

- [docs/PRODUCT.md](docs/PRODUCT.md) — spec: ranking rules, display, key operations
- [docs/DESIGN.md](docs/DESIGN.md) — how it works: dependencies, hooks, OpenTelemetry and transcripts
- [docs/adr/](docs/adr/) — decisions that hold across rewrites
- [docs/claude-code-behavior.md](docs/claude-code-behavior.md) — observed behavior of `claude` that whatnext relies on
- [CONTEXT.md](CONTEXT.md) — glossary

## Development

This project is rebuilt from scratch in cycles; only the docs above persist. See [CLAUDE.md](CLAUDE.md).

```sh
npm run build      # tsc (strict)
npm run check      # biome (format and lint)
npm test           # unit tests
npm run test:e2e   # drives whatnext in a private tmux server with a fake claude
npm run test:real  # uses the real claude (haiku) and Ghostty; creates and removes its own sessions
```

The tests use their own tmux socket, port and state file, so they never touch a whatnext you are running.

## License

MIT
