import {execFile, spawn} from 'node:child_process';
import stringWidth from 'string-width';
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
		// whatnext の操作は ctrl を押したままの形(キーの説明もこの形)。l は作業台で tmux の last-window なので、文字だけの形は割り当てない。
		// y・e・h は tmux の既定の割り当てがないので、文字だけでも同じ動作にする(説明には載せない)
		`bind -T wnq C-l ${keyCmd('back', "'#{session_name}'", "'#{client_tty}'")}`,
		...['y', 'C-y'].map(k => `bind -T wnq ${k} ${keyCmd('req', 'menu', "'#{session_name}'", "'#{client_tty}'", "'#{pane_id}'")}`),
		...['e', 'C-e'].map(k => `bind -T wnq ${k} ${keyCmd('req', 'ext', "'#{session_name}'", "'#{client_tty}'")}`),
		// 一覧の h と Ctrl+X を attach の中に持ち込む。x は作業台で tmux の kill-pane なので、ctrl を押したままの形だけにする
		...['h', 'C-h'].map(k => `bind -T wnq ${k} ${keyCmd('backreq', 'hold', "'#{session_name}'", "'#{client_tty}'")}`),
		`bind -T wnq C-x ${keyCmd('backreq', 'stop', "'#{session_name}'", "'#{client_tty}'")}`,
		// 一覧の n。n は作業台で tmux の next-window なので、ctrl を押したままの形だけにする
		`bind -T wnq C-n ${keyCmd('backreq', 'new', "'#{session_name}'", "'#{client_tty}'")}`,
		// 一覧の w。w は作業台で tmux の choose-tree なので、ctrl を押したままの形だけにする
		`bind -T wnq C-w ${keyCmd('backreq', 'wait', "'#{session_name}'", "'#{client_tty}'")}`,
		// Up next の先頭へ移る。j は tmux の既定の割り当てがないので、文字だけでも同じ動作にする(説明には載せない)
		...['j', 'C-j'].map(k => `bind -T wnq ${k} ${keyCmd('req', 'next', "'#{session_name}'", "'#{client_tty}'")}`),
		// 作業台(popup の中のクライアント): ctrl+q が prefix
		'bind C-q detach-client',
		`bind C-l ${keyCmd('back', "'#{session_name}'", "'#{client_tty}'")}`,
		// サーバを作り直さずに設定を入れ直したときも、前の版の割り当てを残さない
		'bind l last-window',
		'unbind -q -T wnq l',
		...['y', 'C-y'].map(k => `bind ${k} ${keyCmd('req', 'menu', "'#{session_name}'", "'#{client_tty}'", "'#{pane_id}'")}`),
		...['e', 'C-e'].map(k => `bind ${k} ${keyCmd('req', 'ext', "'#{session_name}'", "'#{client_tty}'")}`),
		...['h', 'C-h'].map(k => `bind ${k} ${keyCmd('backreq', 'hold', "'#{session_name}'", "'#{client_tty}'")}`),
		`bind C-x ${keyCmd('backreq', 'stop', "'#{session_name}'", "'#{client_tty}'")}`,
		`bind C-n ${keyCmd('backreq', 'new', "'#{session_name}'", "'#{client_tty}'")}`,
		`bind C-w ${keyCmd('backreq', 'wait', "'#{session_name}'", "'#{client_tty}'")}`,
		...['j', 'C-j'].map(k => `bind ${k} ${keyCmd('req', 'next', "'#{session_name}'", "'#{client_tty}'")}`),
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

// claude の画面の下の2行(一覧と作業台には出さない)。
// 上: 名前 · 最初の依頼(一覧が @wn_title・@wn_first に置く。最初の依頼を幅で切る)。下: 左に作業台で動いているもの、右にキーの説明
const SUMMARY_FORMAT =
	'#[align=left fg=default]#{=/#{client_width}/…:@wn_title}#[fg=colour245]' +
	'#{?#{&&:#{@wn_first},#{e|<:#{@wn_titlew},#{client_width}}}, · #{=/#{e|-:#{client_width},#{@wn_titlew}}/…:@wn_first},}';
const claudeStatus = (id: string): Array<[string, string]> => [
	['status', '2'],
	['status-format[0]', SUMMARY_FORMAT],
	['status-format[1]', '#[align=left]#{T;=/#{status-left-length}:status-left}#[align=right]#{T;=/#{e|-:#{client_width},1}/…:status-right}'],
	['status-position', 'bottom'],
	['status-interval', '2'],
	['status-style', 'fg=colour245,bg=default'],
	['status-left-length', '80'],
	['window-status-format', ''],
	['window-status-current-format', ''],
	['window-status-separator', ''],
	['status-right-length', '200'],
	['status-left', `#(${shCall('wb', id)})`],
	['status-right', '^Q^Q workbench · ^Q^L back · ^Q^J next · ^Q^Y ! commands · ^Q^E external · ^Q^H hold · ^Q^X stop · ^Q^N new · ^Q^W wait'],
];

// claude の画面のセッション <id> を作る(なければ)。中で claude attach <id> が動く。
export async function ensureClaudeSession(id: string, cwd: string, name: string): Promise<boolean> {
	if (await hasSession(id)) {
		// 前の版の一覧が作ったセッションにも、今の版のステータス行を入れる
		await setOpts(id, [['@wn_name', name], ...claudeStatus(id)]);
		return true;
	}
	const r = await tmux('new-session', '-d', '-s', id, '-c', cwd, ...keyArgv('attach', id));
	if (!r.ok) return false;
	await setOpts(id, [['prefix', 'None'], ['@wn_claude', '1'], ['@wn_id', id], ['@wn_cwd', cwd], ['@wn_name', name], ...claudeStatus(id)]);
	return true;
}

// claude の画面の概要の行に出す、名前と最初の依頼。tmux は値の中の # を書式として読むので ## にする
export async function setSummary(id: string, title: string, first: string | undefined) {
	const esc = (s: string) => s.replaceAll('#', '##');
	await setOpts(id, [
		['@wn_title', esc(title)],
		['@wn_titlew', String(stringWidth(title) + 3)],
		['@wn_first', esc(first ?? '')],
	]);
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
