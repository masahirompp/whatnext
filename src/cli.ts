#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {SOCKET, envWithoutTmux} from './env.js';
import {launch, launchWorkbench, USAGE} from './launcher.js';

// 自分のペインが専用サーバのどのセッションにあるか。専用サーバの中でなければ undefined。
// WHATNEXT_ROLE は whatnext の中で動くシェルにも引き継がれるので、それだけでは一覧の役と決めない
// (引き継いだシェルで起動した whatnext が利用者のサーバで一覧として動き、後始末で attach を畳んだ)。
function paneSession(): string | undefined {
	const pane = process.env.TMUX_PANE;
	// 利用者の tmux の中なら TMUX_PANE は利用者のサーバのもの。ソケットで確かめる
	const socket = process.env.TMUX?.split(',')[0] ?? '';
	if (!pane || !socket.endsWith(`/${SOCKET}`)) return undefined;
	const r = spawnSync('tmux', ['-L', SOCKET, 'display', '-p', '-t', pane, '#{session_name}'], {env: envWithoutTmux(), encoding: 'utf8'});
	return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

async function main(): Promise<number> {
	const inside = paneSession();
	if (process.env.WHATNEXT_ROLE === 'list' && inside === 'list') {
		const {runList} = await import('./list.js');
		return runList();
	}
	const args = process.argv.slice(2);
	if (args[0] === '--help') {
		process.stdout.write(USAGE + '\n');
		return 0;
	}
	const workbench = args[0] === 'workbench';
	const rest = workbench ? args.slice(1) : args;
	if (rest.length) {
		process.stderr.write(`whatnext: unknown option ${rest[0]}\n${USAGE}\n`);
		return 2;
	}
	// whatnext の中(作業台や claude の Bash)から起動すると、専用サーバに入れ子でつながり、画面が自分自身を映す
	if (inside) {
		process.stderr.write(`whatnext: this shell runs inside whatnext. Run "whatnext${workbench ? ' workbench' : ''}" in another split or window of your terminal.\n`);
		return 1;
	}
	return workbench ? launchWorkbench() : launch();
}

process.exitCode = await main();
