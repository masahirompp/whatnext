#!/usr/bin/env node
import {run} from '../lib/input/exec.js';
import {LIST} from '../lib/tmux/tmux.js';
import {insideWhatnext, readEnv, tmuxEnv} from './cli/env.js';
import {guide} from './cli/guide.js';
import {hasTmux, launch} from './cli/launch.js';
import {startList} from './cli/list.js';
import {workbench} from './cli/workbench.js';

const USAGE = `Usage: whatnext [--help]
       whatnext workbench

A terminal list of your parallel Claude Code sessions, grouped by repository.

  whatnext            Open the list (or come back to the one that is running)
  whatnext workbench  Show the workbench shell of the session you are looking at (run it in a split)
  --help              Show this help
`;

/** 引数を振り分ける。`--help` は先頭の引数にあるときだけ。 */
export function parseArgs(args: readonly string[]): {cmd: 'help' | 'list' | 'workbench'} | {cmd: 'bad'; arg: string} {
  if (args[0] === '--help') return {cmd: 'help'};
  if (args.length === 0) return {cmd: 'list'};
  if (args[0] === 'workbench' && args.length === 1) return {cmd: 'workbench'};
  const bad = args[0] === 'workbench' ? args[1] : args[0];
  return {cmd: 'bad', arg: bad};
}

async function inListPane(socket: string): Promise<boolean> {
  const pane = process.env.TMUX_PANE;
  if (!pane) return false;
  const r = await run('tmux', ['-L', socket, 'display-message', '-p', '-t', pane, '#{session_name}'], {
    env: tmuxEnv(),
    timeout: 5000,
  });
  return r.code === 0 && r.stdout.trim() === LIST;
}

async function main(): Promise<number> {
  const env = readEnv();
  const role = process.env.WHATNEXT_ROLE;
  if (role === 'list' && (await inListPane(env.socket))) return startList(env);
  if (role === 'guide' && process.env.TMUX) return guide(env);

  const a = parseArgs(process.argv.slice(2));
  if (a.cmd === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (a.cmd === 'bad') {
    process.stderr.write(`whatnext: unknown option ${a.arg}\n${USAGE}`);
    return 2;
  }
  if (insideWhatnext(env)) {
    process.stderr.write(
      'whatnext: this shell runs inside whatnext. Run "whatnext" in another split or window of your terminal.\n',
    );
    return 1;
  }
  if (!(await hasTmux())) {
    process.stderr.write(
      'whatnext: tmux is not installed. whatnext runs the list, sessions and workbench shells in its own tmux server. Install tmux and try again.\n',
    );
    return 1;
  }
  if (a.cmd === 'workbench') return workbench(env);
  return launch(env);
}

main().then(
  code => process.exit(code),
  err => {
    process.stderr.write(`whatnext: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
