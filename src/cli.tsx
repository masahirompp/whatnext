#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import readline from 'node:readline';
import {spawnSync} from 'node:child_process';
import {App} from './app.js';
import {PORT, startReceiver} from './receiver.js';
import {closeIdle, hasTmux, killServer, sessionNames, setupServer, SOCKET, workbenchRunning} from './tmux.js';
import {readAgents} from './sys.js';

const HELP = `whatnext - a list of your parallel Claude Code sessions, ordered by which one to touch next.

Usage: whatnext [--help]

Keys in the list:
  up/down      move
  enter        attach to the session (interactive sessions: show where they run)
  n            start a new session
  w            wait for another session (nest it under this one)
  h            put on hold / take off hold
  e            show the session in another app (PR, VS Code)
  c            copy a \`! <command>\` the session suggested in its last response
  ctrl+x       stop; press again within 2s to delete
  r            refresh
  q            quit

While attached:
  ctrl+q ctrl+q   show / hide the workbench (a shell in the session's directory)
  ctrl+q l        back to the list
  ctrl+q y        copy a suggested \`! <command>\` (in the workbench, also paste it)
  ctrl+z, or <- on an empty prompt, also return to the list.

Requires claude, git and tmux.`;

async function ask(question: string): Promise<string> {
	const rl = readline.createInterface({input: process.stdin, output: process.stdout});
	return new Promise(resolve =>
		rl.question(question, a => {
			rl.close();
			resolve(a.trim());
		}),
	);
}

/** Synchronous cleanup for when we cannot ask: keep only workbenches running something. */
function closeIdleSync() {
	const t = (args: string[]) =>
		spawnSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], {encoding: 'utf8', timeout: 3000});
	const panes = t(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}']);
	if (panes.status !== 0) return;
	const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], {encoding: 'utf8', timeout: 3000}).stdout ?? '';
	const procs = ps
		.split('\n')
		.map(l => l.trim().split(/\s+/))
		.filter(x => x.length === 3);
	const busy = new Set<string>();
	for (const line of panes.stdout.split('\n').filter(Boolean)) {
		const [sess, pid] = line.split('\t');
		if (sess?.startsWith('sh-') && procs.some(([p, pp, pg]) => pp === pid && p === pg)) busy.add(sess);
	}
	const names = t(['list-sessions', '-F', '#{session_name}']).stdout?.split('\n').filter(Boolean) ?? [];
	for (const n of names) if (!busy.has(n)) t(['kill-session', '-t', `=${n}`]);
	if (!busy.size) t(['kill-server']);
}

async function main() {
	if (process.argv.includes('--help') || process.argv.includes('-h')) {
		console.log(HELP);
		return;
	}
	if (!(await hasTmux())) {
		console.error('whatnext needs tmux for the workbench, but tmux was not found. Install tmux (3.2 or later) and try again.');
		process.exit(1);
	}
	const rec = await startReceiver();
	if (rec === 'other-whatnext') {
		console.error(`whatnext is already running (it listens on 127.0.0.1:${PORT}). Use that one, or quit it first.`);
		process.exit(1);
	}

	// A previous whatnext may have left its tmux server behind.
	if ((await sessionNames()).length) {
		const running = await closeIdle();
		if (running.size) {
			let names = new Map<string, string>();
			try {
				names = new Map((await readAgents()).filter(r => r.id).map(r => [r.id!, r.name ?? r.id!]));
			} catch {}
			const items = [...running].flatMap(([id, cmds]) => cmds.map(c => `${names.get(id) ?? id}: ${c}`));
			const n = items.length;
			const a = await ask(
				`${n} command${n === 1 ? ' is' : 's are'} still running from a previous whatnext: ${items.join(', ')}. Keep ${n === 1 ? 'it' : 'them'}? [Y/n] `,
			);
			if (/^n/i.test(a)) await killServer();
		} else {
			await killServer();
		}
	}
	const setup = await setupServer();
	if (setup.code !== 0) {
		console.error(`whatnext could not start its tmux server: ${setup.stderr.trim()}`);
		process.exit(1);
	}

	let quitting = false;
	const onSignal = () => {
		if (quitting) return;
		quitting = true;
		try {
			closeIdleSync();
		} finally {
			process.exit(0);
		}
	};
	process.on('SIGHUP', onSignal);
	process.on('SIGTERM', onSignal);
	process.on('uncaughtException', err => {
		try {
			closeIdleSync();
		} catch {}
		console.error(err);
		process.exit(1);
	});
	void workbenchRunning;

	const app = render(<App launchDir={process.cwd()} onQuit={() => (quitting = true)} />, {
		exitOnCtrlC: false,
		alternateScreen: true,
	});
	await app.waitUntilExit();
	process.exit(0);
}

void main();
