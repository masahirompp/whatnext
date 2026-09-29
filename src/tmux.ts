import {execFile, spawn} from 'node:child_process';
import {SOCKET, VERSION, envWithoutTmux} from './env.js';
import {KEY_SH} from './keysh.js';

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

export const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// KEY_SH を呼ぶシェルのコマンド。本文はサーバのオプション @wn_sh から取る(どのペインの環境にも置かない)
export const shCall = (action: string, ...args: string[]) =>
	`sh -c "$(tmux -L ${q(SOCKET)} show -gv @wn_sh)" wn ${q(SOCKET)} ${action} ${args.join(' ')}`;

// キーとフックから呼ぶ sh。出力と 0 以外の終了は tmux が view mode で被せるので抑える
export const keyCmd = (action: string, ...args: string[]) => `run-shell -b ${q(`${shCall(action, ...args)} >/dev/null 2>&1; true`)}`;

// ペインのコマンドとして KEY_SH を動かす argv(tmux は複数の引数をシェルを通さずに実行する)
const keyArgv = (action: string, ...args: string[]) => ['sh', '-c', KEY_SH, 'wn', SOCKET, action, ...args];

// 一覧のプロセスが起動するたびに、サーバ全体の設定を入れ直す(異常終了のあとも同じ)。
export async function configureServer(pid: number): Promise<string> {
	await tmux('set', '-g', '@wn_sh', KEY_SH);
	const lines = [
		`set -g @wn_pid ${pid}`,
		`set -g @wn_version ${q(VERSION)}`,
		'set -g status off',
		'set -g escape-time 10',
		'set -g default-terminal tmux-256color',
		// terminal-features はクライアントが attach する前に要るので、サーバを作るときに入れる(launcher.ts)
		'set -g extended-keys on',
		'set -g extended-keys-format csi-u',
		'set -g set-clipboard on',
		'set -g allow-passthrough on',
		'set -g focus-events on',
		'set -g history-limit 20000',
		// on にしないと、作業台の最後のシェルを抜けたとき popup の中のクライアントが別のセッションに移り、popup が入れ子になる。
		// claude の画面は、畳む前にクライアントを一覧へ切り替える(KEY_SH)
		'set -g detach-on-destroy on',
		'set -g exit-empty on',
		// 作業台(sh-<id>)だけで prefix が効く。一覧と claude の画面ではセッションごとに None にする
		'set -g prefix C-q',
		'set -g prefix2 None',
		'unbind C-b',
		// claude の画面: ctrl+q は専用のキー表に入る。ほかの ctrl+q の組み合わせは何もしない
		`bind -n C-q if -F '#{@wn_claude}' 'switch-client -T wnq' 'send-keys C-q'`,
		`bind -T wnq C-q ${keyCmd('popup', "'#{session_name}'", "'#{client_tty}'")}`,
		// ctrl を押したままの ^Q^L / ^Q^Y / ^Q^E も同じ動作にする(^Q^Q で ctrl を押したままの手癖が付くため)
		...['l', 'C-l'].map(k => `bind -T wnq ${k} ${keyCmd('back', "'#{session_name}'", "'#{client_tty}'")}`),
		...['y', 'C-y'].map(k => `bind -T wnq ${k} ${keyCmd('req', 'menu', "'#{session_name}'", "'#{client_tty}'", "'#{pane_id}'")}`),
		...['e', 'C-e'].map(k => `bind -T wnq ${k} ${keyCmd('req', 'ext', "'#{session_name}'", "'#{client_tty}'")}`),
		// 作業台(popup の中のクライアント): ctrl+q が prefix
		'bind C-q detach-client',
		...['l', 'C-l'].map(k => `bind ${k} ${keyCmd('back', "'#{session_name}'", "'#{client_tty}'")}`),
		...['y', 'C-y'].map(k => `bind ${k} ${keyCmd('req', 'menu', "'#{session_name}'", "'#{client_tty}'", "'#{pane_id}'")}`),
		...['e', 'C-e'].map(k => `bind ${k} ${keyCmd('req', 'ext', "'#{session_name}'", "'#{client_tty}'")}`),
		// 一覧に知らせる。一覧は tmux に問い合わせて、何が起きたかを自分で判断する
		`set-hook -g client-session-changed ${q(keyCmd('notify'))}`,
		`set-hook -g client-attached ${q(keyCmd('notify'))}`,
		`set-hook -g client-detached ${q(keyCmd('notify'))}`,
		`set-hook -g session-closed ${q(keyCmd('notify'))}`,
		// 空のプロンプトの ← で Agent View に入った(端末のタイトルが claude agents に変わる)
		`set-hook -g pane-title-changed ${q(`if -F '#{&&:#{@wn_claude},#{m:*claude agents*,#{pane_title}}}' ${q(keyCmd('left', "'#{session_name}'"))}`)}`,
		'set -t =list: prefix None',
	];
	return sourceLines(lines);
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
	return r.out
		.split('\n')
		.filter(Boolean)
		.map(line => {
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

// set の -t は target-pane なので、=<名前>: の形で指す(=<名前> だけでは no such session)
async function setOpts(session: string, opts: Array<[string, string]>) {
	for (const [k, v] of opts) await tmux('set', '-t', `=${session}:`, k, v);
}

// claude の画面の最下行: 左に作業台で動いているもの、右にキーの説明(一覧と作業台には出さない)
const claudeStatus = (id: string): Array<[string, string]> => [
	['status', 'on'],
	['status-position', 'bottom'],
	['status-interval', '2'],
	['status-style', 'fg=colour245,bg=default'],
	['status-left-length', '80'],
	['window-status-format', ''],
	['window-status-current-format', ''],
	['window-status-separator', ''],
	['status-right-length', '80'],
	['status-left', `#(${shCall('wb', id)})`],
	['status-right', '^Q^Q workbench · ^Q l back · ^Q y ! commands · ^Q e external'],
];

// claude の画面のセッション <id> を作る(なければ)。中で claude attach <id> が動く。
export async function ensureClaudeSession(id: string, cwd: string, name: string): Promise<boolean> {
	if (await hasSession(id)) {
		await setOpts(id, [['@wn_name', name]]);
		return true;
	}
	const r = await tmux('new-session', '-d', '-s', id, '-c', cwd, ...keyArgv('attach', id));
	if (!r.ok) return false;
	await setOpts(id, [['prefix', 'None'], ['@wn_claude', '1'], ['@wn_id', id], ['@wn_cwd', cwd], ['@wn_name', name], ...claudeStatus(id)]);
	return true;
}

// 信頼の確認を出すための、対話モードの claude の画面 <name>。claude が終わるとクライアントを一覧へ戻す(KEY_SH)
export async function openTrustSession(name: string, cwd: string): Promise<boolean> {
	const r = await tmux('new-session', '-d', '-s', name, '-c', cwd, ...keyArgv('trust', name));
	if (!r.ok) return false;
	await setOpts(name, [['prefix', 'None']]);
	return true;
}

export async function takeOption(name: string): Promise<string | undefined> {
	const r = await tmux('show', '-gv', name);
	const v = r.ok ? r.out.trim() : '';
	if (!v) return undefined;
	await tmux('set', '-gu', name);
	return v;
}
