import {execFileSync, spawnSync} from 'node:child_process';
import {CLI, PORT, SOCKET, VERSION, envWithoutTmux} from './env.js';

export const USAGE = `Usage: whatnext [--help]

A terminal list of your parallel Claude Code sessions, ordered by which one to touch next.

Options:
  --help  Show this help`;

const run = (args: string[]) => spawnSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], {env: envWithoutTmux(), encoding: 'utf8'});

async function anotherWhatnext(): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/v1/whatnext`, {signal: AbortSignal.timeout(1000)});
		const text = await res.text();
		return res.ok && text.includes('whatnext');
	} catch {
		return false;
	}
}

export async function launch(): Promise<number> {
	try {
		execFileSync('tmux', ['-V'], {stdio: 'ignore'});
	} catch {
		process.stderr.write('whatnext: tmux was not found. whatnext needs tmux 3.2 or later for the workbench. Install tmux and try again.\n');
		return 1;
	}

	const hasList = run(['has-session', '-t', '=list']).status === 0;
	if (hasList) {
		// 動いている一覧の版が違えば、一覧の下に示させる(端末を閉じても終了しないので、更新が効いていないことが見えない)
		const running = run(['show', '-gv', '@wn_version']).stdout?.trim();
		const notice = running && running !== VERSION ? `whatnext ${running} is still running. Quit it to start ${VERSION}.` : '-';
		run(['set', '-g', '@wn_notice', notice]);
	} else {
		if (await anotherWhatnext()) {
			process.stderr.write(`whatnext: another whatnext is already running (port ${PORT}). Quit it first.\n`);
			return 1;
		}
		const cols = String(process.stdout.columns || 120);
		const rows = String(process.stdout.rows || 40);
		const r = run([
			'new-session', '-d', '-s', 'list', '-x', cols, '-y', rows, '-c', process.cwd(),
			'-e', 'WHATNEXT_ROLE=list',
			'-e', `WHATNEXT_TMUX_SOCKET=${SOCKET}`,
			'-e', `WHATNEXT_PORT=${PORT}`,
			process.execPath, CLI,
		]);
		if (r.status !== 0) {
			process.stderr.write(`whatnext: could not start tmux: ${r.stderr.trim()}\n`);
			return 1;
		}
	}

	// 別の端末のウィンドウに映っていれば、そちらを離してシェルに戻す
	const clients = run(['list-clients', '-F', '#{client_name}']).stdout?.split('\n').filter(Boolean) ?? [];
	for (const c of clients) run(['detach-client', '-t', c]);

	const r = spawnSync('tmux', ['-L', SOCKET, 'attach-session', '-t', '=list'], {env: envWithoutTmux(), stdio: 'inherit'});
	// 終了の操作でサーバごと閉じたときは、tmux が残す `[server exited]` の行を消して正常に終わる
	if (run(['has-session', '-t', '=list']).status !== 0) {
		process.stdout.write('\x1b[1A\x1b[2K');
		return 0;
	}
	return r.status ?? 0;
}
