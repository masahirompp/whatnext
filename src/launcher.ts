import {execFileSync, spawnSync} from 'node:child_process';
import {CLI, PORT, SOCKET, VERSION, envWithoutTmux} from './env.js';

export const USAGE = `Usage: whatnext [--help]
       whatnext workbench

A terminal list of your parallel Claude Code sessions, ordered by which one to touch next.

Commands:
  workbench  Show the workbench of the session you are on. Run it in another split of your terminal.

Options:
  --help  Show this help`;

const run = (args: string[]) => spawnSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], {env: envWithoutTmux(), encoding: 'utf8'});

const hasTmux = () => {
	try {
		execFileSync('tmux', ['-V'], {stdio: 'ignore'});
		return true;
	} catch {
		return false;
	}
};

// この端末の tty(tmux の #{client_tty} と同じ形)。whatnext の画面と作業台の画面を見分けるのに使う
function myTty(): string {
	const r = spawnSync('tty', [], {stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8'});
	return r.status === 0 ? r.stdout.trim() : '';
}

const option = (name: string) => run(['show', '-gv', name]).stdout?.trim() ?? '';

const attachedTtys = () => run(['list-clients', '-F', '#{client_tty}']).stdout?.split('\n').filter(Boolean) ?? [];

async function anotherWhatnext(): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/v1/whatnext`, {signal: AbortSignal.timeout(1000)});
		const text = await res.text();
		return res.ok && text.includes('whatnext');
	} catch {
		return false;
	}
}

// 終了の操作でサーバごと閉じたときは、tmux が残す `[server exited]` の行を消して正常に終わる
function afterAttach(status: number | null): number {
	if (run(['has-session', '-t', '=list']).status !== 0) {
		process.stdout.write('\x1b[1A\x1b[2K');
		return 0;
	}
	return status ?? 0;
}

const NO_TMUX = 'whatnext: tmux was not found. whatnext needs tmux for the workbench. Install tmux and try again.\n';

export async function launch(): Promise<number> {
	if (!hasTmux()) {
		process.stderr.write(NO_TMUX);
		return 1;
	}

	const hasList = run(['has-session', '-t', '=list']).status === 0;
	if (hasList) {
		// 動いている一覧の版が違えば、一覧の下に示させる(端末を閉じても終了しないので、更新が効いていないことが見えない)
		const running = option('@wn_version');
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
			// クライアントの端末の機能は attach した時点の値で決まり、あとで変えても効かない。一覧が設定を入れるより先に attach するので、ここで入れる。
			// hyperlinks がないと、ペインの中の OSC 8 のリンクを外側の端末へ送らない。OSC 8 を知らない端末で崩れないよう、xterm 系と Ghostty に限る
			';', 'set', '-as', 'terminal-features', ',xterm*:RGB:hyperlinks,ghostty*:RGB:hyperlinks,*-256color:RGB',
		]);
		if (r.status !== 0) {
			process.stderr.write(`whatnext: could not start tmux: ${r.stderr.trim()}\n`);
			return 1;
		}
	}

	// この端末を whatnext の画面にする。別の端末に映っていれば、そちらを離してシェルに戻す(作業台の画面は離さない)
	const tty = myTty();
	const wbTty = option('@wn_wb_tty');
	if (tty) {
		run(['set', '-g', '@wn_main_tty', tty]);
		if (wbTty === tty) run(['set', '-gu', '@wn_wb_tty']);
	}
	for (const c of attachedTtys()) if (c !== wbTty || c === tty) run(['detach-client', '-t', c]);

	const r = spawnSync('tmux', ['-L', SOCKET, 'attach-session', '-t', '=list'], {env: envWithoutTmux(), stdio: 'inherit'});
	return afterAttach(r.status);
}

// whatnext workbench: 専用サーバの2つ目のクライアントとして、作業台の画面を開く
export async function launchWorkbench(): Promise<number> {
	if (!hasTmux()) {
		process.stderr.write(NO_TMUX);
		return 1;
	}
	if (run(['has-session', '-t', '=list']).status !== 0) {
		process.stderr.write('whatnext is not running. Start whatnext first.\n');
		return 1;
	}
	// 作業台の画面は同時に1つだけ。前の作業台の画面は離してシェルに戻す
	const tty = myTty();
	const old = option('@wn_wb_tty');
	if (old && old !== tty && attachedTtys().includes(old)) run(['detach-client', '-t', old]);
	if (tty) {
		run(['set', '-g', '@wn_wb_tty', tty]);
		if (option('@wn_main_tty') === tty) run(['set', '-gu', '@wn_main_tty']);
	}
	// 案内のセッションは一覧が作る。まだなければ(一覧が起動した直後など)少し待つ
	for (let i = 0; i < 20 && run(['has-session', '-t', '=wbguide']).status !== 0; i++) await new Promise(res => setTimeout(res, 100));
	const r = spawnSync('tmux', ['-L', SOCKET, 'attach-session', '-t', '=wbguide'], {env: envWithoutTmux(), stdio: 'inherit'});
	// 作業台のセッションが端末に出したタイトル(whatnext workbench)を消す。残ると ctrl+q ctrl+w が、作業台の画面のない分割へ移る
	process.stdout.write('\x1b]2;\x07');
	return afterAttach(r.status);
}
