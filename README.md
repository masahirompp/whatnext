# whatnext

A terminal list of your parallel Claude Code sessions, grouped by repository — with the sessions that depend on each other nested together, and what each one is doing shown on every row.

When you split work across sessions (an implementation and its review, a big task and its parts, a fix that has to land in another repository first, sessions that an orchestrating session started), whatnext keeps each group together under one row, across repositories. Mark that a session waits for others, and it shows as `Waiting` until they finish, then goes back to its own status. Pick a row to attach, detach to come back to the list.

> **Status: 0.x — expect breaking changes without notice.**

## Principles

- **Reads session state from `claude agents --json` alone.** No screen scraping. To show what each session is doing and how long it has waited, whatnext also reads hook events from sessions it started and, for other sessions, Claude Code's own conversation transcripts (`~/.claude/projects`) — read-only. Account usage comes from `claude`'s own `/usage`, which calls no model.
- **Sessions whatnext starts send their context size (OpenTelemetry) and hook events to whatnext on 127.0.0.1:14318, only while whatnext is running.** Nothing leaves your machine and nothing is stored.
- **Keeps almost no state.** Sessions keep running after you quit whatnext, and sessions started elsewhere show up too. Your settings are never modified. The only file whatnext writes is `~/.local/state/whatnext/state.json` (or under `$XDG_STATE_HOME`), which keeps your notes, wait-for links and the order of the list across restarts.
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
| `Ctrl+X` | Stop the session; press again within 2s to delete it (asks before deleting the sessions it waits for) |
| `e` | Write a one-line note on the session (an empty note removes it) |
| `f` | Choose the sessions this one waits for (or start a new one to wait for) |
| `w` | Create the session's workbench shell |
| `v` | Open the session's directory in VS Code |
| `r` | Refresh |
| `q` | Quit (asks first if something is still running in a workbench) |

While attached, `ctrl+q` followed by the same letter with ctrl held does the same thing (`ctrl+q ctrl+l` goes back to the list, `ctrl+q ctrl+e` opens the note of the session). The keys are shown at the bottom of the session's screen.

Rows marked `(tty)` are interactive sessions, and rows marked `(sub)` are `claude` processes that another row started (from a skill, a script or an MCP server). Both can be selected but not attached. A `(tty)` row can be waited for but cannot wait for other sessions (`f` declines), and `(sub)` rows take no notes or wait-for links.

### Nesting `claude -p` started by an MCP server

`claude -p` started by a stdio MCP server, a skill or a script nests under the session that started it without any setup. An MCP server that runs outside the conversation (an HTTP server, a daemon) is not a child process of the session, so whatnext cannot tell which session called it — unless the server passes the caller's pid to the `claude -p` it starts, in the environment variable `MCP_CALLER_PID`. Two changes on your side:

1. Add a `headersHelper` to the server in your MCP config. Claude Code runs it on every connection, and its `$PPID` is the `claude` process of the calling session:

   ```json
   {
     "mcpServers": {
       "my-orchestrator": {
         "type": "http",
         "url": "http://127.0.0.1:8765/mcp",
         "headersHelper": "/path/to/caller-pid.sh"
       }
     }
   }
   ```

   ```sh
   #!/bin/sh
   # caller-pid.sh
   printf '{"X-MCP-Caller-Pid": "%s"}' "$PPID"
   ```

2. In the MCP server, copy the header of the request into the environment of the `claude -p` it starts:

   ```js
   // in the tools/call handler (Node)
   const env = {...process.env};
   const caller = req.headers['x-mcp-caller-pid'];
   if (caller) env.MCP_CALLER_PID = String(caller);
   spawn('claude', ['-p', prompt], {env});
   ```

whatnext nests a row under the session whose pid matches `MCP_CALLER_PID`, and otherwise shows it as a normal `(tty)` row. The server, the sessions and whatnext have to run on the same machine.

## Requirements

- Node.js 22 or later
- [Claude Code](https://code.claude.com) (`claude`), `git`, and `tmux` (tested with 3.7c and 3.8) (whatnext runs the list, sessions and per-session workbench shells in its own tmux server; your tmux config is not touched. Closing the terminal window leaves whatnext running — run it again to come back to the same list. Quitting whatnext closes the workbench shells — it asks first if something is still running)
- Optional: `ghq` (more working-directory candidates), `gh` (PR numbers on rows). Without them, whatnext works the same with less shown.

## Documentation

Design documents are written in Japanese.

- [docs/PRODUCT.md](docs/PRODUCT.md) — spec: status rules, dependencies, display, key operations
- [docs/DESIGN.md](docs/DESIGN.md) — how it works: dependencies, hooks, OpenTelemetry and transcripts
- [docs/adr/](docs/adr/) — decisions that hold across rewrites
- [docs/claude-code-behavior.md](docs/claude-code-behavior.md) — observed behavior of `claude` that whatnext relies on
- [CONTEXT.md](CONTEXT.md) — glossary

## Development

This project is rebuilt from scratch in cycles; only the docs above and `lib/` persist. See [CLAUDE.md](CLAUDE.md).

```sh
npm run build      # tsc (strict)
npm run check      # biome (format and lint)
npm test           # unit tests (including lib/)
npm run test:e2e   # drives whatnext in a private tmux server with a fake claude
npm run test:real  # uses the real claude (haiku) and Ghostty; creates and removes its own sessions
```

The tests use their own tmux socket, port and state file, so they never touch a whatnext you are running.

## License

MIT
