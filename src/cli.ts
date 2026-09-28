#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {SOCKET, envWithoutTmux} from './env.js';
import {launch, USAGE} from './launcher.js';

// 自分のペインが専用サーバのどのセッションにあるか。専用サーバの中でなければ undefined。
// WHATNEXT_ROLE は whatnext の中で動くシェルにも引き継がれるので、それだけでは一覧の役と決めない
// (引き継いだシェルで起動した whatnext が利用者のサーバで一覧として動き、後始末で attach を畳んだ)。
function paneSession(): string | undefined {
	const pane = process.env.TMUX_PANE;
	if (!pane) return undefined;
	const r = spawnSync('tmux', ['-L', SOCKET, 'display', '-p', '-t', pane, '#{session_name}'], {env: envWithoutTmux(), encoding: 'utf8'});
	return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

async function main(): Promise<number> {
	if (process.env.WHATNEXT_ROLE === 'list' && paneSession() === 'list') {
		const {runList} = await import('./list.js');
		return runList();
	}
	for (const arg of process.argv.slice(2)) {
		if (arg === '--help') {
			process.stdout.write(USAGE + '\n');
			return 0;
		}
		process.stderr.write(`whatnext: unknown option ${arg}\n${USAGE}\n`);
		return 2;
	}
	return launch();
}

process.exitCode = await main();
