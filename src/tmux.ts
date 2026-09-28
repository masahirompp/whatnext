import {execFile, spawn} from 'node:child_process';
import {KEY_SH, SOCKET, envWithoutTmux} from './env.js';

export type TmuxResult = {ok: boolean; out: string; err: string};

export function tmux(...args: string[]): Promise<TmuxResult> {
	return new Promise(resolve => {
		execFile('tmux', ['-L', SOCKET, ...args], {env: envWithoutTmux(), timeout: 5000}, (error, stdout, stderr) => {
			resolve({ok: !error, out: String(stdout), err: String(stderr)});
		});
	});
}

// 終わりを待たない(display-menu などは閉じるまで戻らない)
export function tmuxDetached(...args: string[]): void {
	const child = spawn('tmux', ['-L', SOCKET, ...args], {env: envWithoutTmux(), stdio: 'ignore', detached: true});
	child.unref();
}

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const key = (action: string, ...args: string[]) =>
	`run-shell -b ${q(`sh ${q(KEY_SH)} ${q(SOCKET)} ${action} ${args.join(' ')} >/dev/null 2>&1; true`)}`;

// 一覧のプロセスが起動するたびに、サーバ全体の設定を入れ直す(異常終了のあとも同じ)。
export async function configureServer(pid: number): Promise<void> {
	const lines = [
		`set -g @wn_pid ${pid}`,
		'set -g status off',
		'set -g escape-time 10',
		'set -g default-terminal tmux-256color',
		'set -as terminal-features ",xterm*:RGB,ghostty*:RGB,*-256color:RGB"',
		'set -g extended-keys on',
		'set -g extended-keys-format csi-u',
		'set -g set-clipboard on',
		'set -g allow-passthrough on',
		// on にしないと、作業台の最後のシェルを抜けたとき popup の中のクライアントが別のセッションに移り、popup が入れ子になる。
		// claude の画面は、畳む前にクライアントを一覧へ切り替える(key.sh)
		'set -g detach-on-destroy on',
		'set -g exit-empty on',
		// 作業台(sh-<id>)だけで prefix が効く。一覧と claude の画面ではセッションごとに None にする
		'set -g prefix C-q',
		'set -g prefix2 None',
		'unbind C-b',
		// claude の画面: ctrl+q は専用のキー表に入る。ほかの ctrl+q の組み合わせは何もしない
		`bind -n C-q if -F '#{@wn_claude}' 'switch-client -T wnq' 'send-keys C-q'`,
		`bind -T wnq C-q ${key('popup', "'#{session_name}'", "'#{client_tty}'")}`,
		`bind -T wnq l ${key('back', "'#{session_name}'", "'#{client_tty}'")}`,
		`bind -T wnq y ${key('req', 'menu', "'#{session_name}'", "'#{client_tty}'", "'#{pane_id}'")}`,
		// 作業台(popup の中のクライアント): ctrl+q が prefix
		'bind C-q detach-client',
		`bind l ${key('back', "'#{session_name}'", "'#{client_tty}'")}`,
		`bind y ${key('req', 'menu', "'#{session_name}'", "'#{client_tty}'", "'#{pane_id}'")}`,
		// 一覧に知らせる。一覧は tmux に問い合わせて、何が起きたかを自分で判断する
		`set-hook -g client-session-changed ${q(key('notify'))}`,
		`set-hook -g client-attached ${q(key('notify'))}`,
		`set-hook -g client-detached ${q(key('notify'))}`,
		`set-hook -g session-closed ${q(key('notify'))}`,
		// 空のプロンプトの ← で Agent View に入った(端末のタイトルが claude agents に変わる)
		`set-hook -g pane-title-changed ${q(`if -F '#{&&:#{@wn_claude},#{m:*claude agents*,#{pane_title}}}' ${q(key('left', "'#{session_name}'"))}`)}`,
		'set -t =list: prefix None',
	];
	const err = await sourceLines(lines);
	if (err) process.env.WHATNEXT_DEBUG && console.error(err);
}

function sourceLines(lines: string[]): Promise<string> {
	return new Promise(resolve => {
		const child = spawn('tmux', ['-L', SOCKET, 'source-file', '-'], {env: envWithoutTmux(), stdio: ['pipe', 'pipe', 'pipe']});
		let out = '';
		child.stdout.on('data', d => (out += d));
		child.stderr.on('data', d => (out += d));
		child.on('close', () => resolve(out));
		child.on('error', () => resolve('spawn error'));
		child.stdin.end(lines.join('\n') + '\n');
	});
}

export type Client = {tty: string; session: string};

export async function listClients(): Promise<Client[]> {
	const r = await tmux('list-clients', '-F', '#{client_tty}\t#{session_name}');
	if (!r.ok) return [];
	return r.out.split('\n').filter(Boolean).map(line => {
		const [tty = '', session = ''] = line.split('\t');
		return {tty, session};
	});
}

export async function listSessions(): Promise<string[]> {
	const r = await tmux('list-sessions', '-F', '#{session_name}');
	return r.ok ? r.out.split('\n').filter(Boolean) : [];
}

export async function hasSession(name: string): Promise<boolean> {
	return (await tmux('has-session', '-t', `=${name}`)).ok;
}

// claude の画面のセッション <id> を作る(なければ)。中で claude attach <id> が動く。
export async function ensureClaudeSession(id: string, cwd: string, name: string): Promise<boolean> {
	if (await hasSession(id)) {
		await tmux('set', '-t', `=${id}:`, '@wn_name', name);
		return true;
	}
	const r = await tmux(
		'new-session', '-d', '-s', id, '-c', cwd,
		'sh', KEY_SH, SOCKET, 'attach', id,
	);
	if (!r.ok) return false;
	// set の -t は target-pane なので、=<名前>: の形で指す(=<名前> だけでは no such session)
	for (const [k, v] of [['prefix', 'None'], ['@wn_claude', '1'], ['@wn_id', id], ['@wn_cwd', cwd], ['@wn_name', name]] as const) {
		await tmux('set', '-t', `=${id}:`, k, v);
	}
	return true;
}

export async function takeRequest(): Promise<string | undefined> {
	const r = await tmux('show', '-gv', '@wn_req');
	const v = r.ok ? r.out.trim() : '';
	if (!v) return undefined;
	await tmux('set', '-gu', '@wn_req');
	return v;
}
