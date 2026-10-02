import {execFile, spawn} from 'node:child_process';
import stringWidth from 'string-width';
import {SOCKET, VERSION, envWithoutTmux} from './env.js';
import {ATTACH_HELP, ATTACH_KEYS, type AttachKey} from './keys.js';
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
export const keyArgv = (action: string, ...args: string[]) => ['sh', '-c', KEY_SH, 'wn', SOCKET, action, ...args];

const SN = "'#{session_name}'";
const CT = "'#{client_tty}'";
const PANE = "'#{pane_id}'";

function keyBinding(k: AttachKey): string {
	if (k.kind === 'back') return keyCmd('back', SN, CT);
	if (k.kind === 'backreq') return keyCmd('backreq', k.action, SN, CT);
	return keyCmd('req', k.action, SN, CT, ...(k.pane ? [PANE] : []));
}

// 一覧のプロセスが起動するたびに、サーバ全体の設定を入れ直す(異常終了のあとも同じ)。
export async function configureServer(pid: number): Promise<string> {
	await tmux('set', '-g', '@wn_sh', KEY_SH);
	const binds: string[] = [];
	for (const k of ATTACH_KEYS) {
		const cmd = keyBinding(k);
		const keys = [`C-${k.letter}`, ...(k.plain ? [k.letter] : [])];
		// claude の画面(キー表 wnq)と、作業台の画面(prefix のキー表)
		for (const key of keys) binds.push(`bind -T wnq ${key} ${cmd}`, `bind ${key} ${cmd}`);
	}
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
		// claude の画面は、畳む前にクライアントを一覧へ切り替える(KEY_SH)。作業台と案内はセッションごとに off にする
		'set -g detach-on-destroy on',
		'set -g exit-empty on',
		// 作業台の最後のシェルが終わったとき、作業台の画面を案内に切り替えてから畳むために、ペインを残して pane-died を受ける。
		// whatnext が作るほかのセッションのウィンドウは off にする
		'set -wg remain-on-exit on',
		'set -w -t =list: remain-on-exit off',
		// 作業台の画面(sh-<id> と wbguide)だけで prefix が効く。一覧と claude の画面ではセッションごとに None にする
		'set -g prefix C-q',
		'set -g prefix2 None',
		'unbind -q C-b',
		// ctrl+q ctrl+q には何も割り当てない(サイクル6までの作業台の出し入れ)。前の版の割り当ても消す
		'unbind -q C-q',
		'unbind -q -T wnq C-q',
		// claude の画面: ctrl+q は専用のキー表に入る。ほかの ctrl+q の組み合わせは何もしない
		`bind -n C-q if -F '#{@wn_claude}' 'switch-client -T wnq' 'send-keys C-q'`,
		...binds,
		// 文字だけの形は、作業台の画面では tmux の既定のキーに返す(サーバを作り直さずに設定を入れ直したときも)
		'bind l last-window',
		// 一覧に知らせる。一覧は tmux に問い合わせて、何が起きたかを自分で判断する
		`set-hook -g client-session-changed ${q(keyCmd('notify'))}`,
		`set-hook -g client-attached ${q(keyCmd('notify'))}`,
		`set-hook -g client-detached ${q(keyCmd('notify'))}`,
		`set-hook -g session-closed ${q(keyCmd('notify'))}`,
		// 作業台の画面にフォーカスが移ったら、案内の場所を今の --json で出し直す(claude が worktree に入ったあと)
		`set-hook -g client-focus-in ${q(keyCmd('focus', "'#{client_tty}'"))}`,
		// 空のプロンプトの ← で Agent View に入った(端末のタイトルが claude agents に変わる)
		`set-hook -g pane-title-changed ${q(`if -F '#{&&:#{@wn_claude},#{m:*claude agents*,#{pane_title}}}' ${q(keyCmd('left', "'#{session_name}'"))}`)}`,
		// 作業台のペインのコマンドが終わった
		`set-hook -g pane-died ${q(`if -F '#{m:sh-*,#{session_name}}' ${q(keyCmd('died', "'#{session_name}'", "'#{pane_id}'"))}`)}`,
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

// whatnext の画面と作業台の画面のクライアント。起動したときに、それぞれの tty をオプションに置いている(launcher.ts)
export async function screens(): Promise<{main?: Client; wb?: Client}> {
	const [clients, mt, wt] = await Promise.all([listClients(), tmux('show', '-gv', '@wn_main_tty'), tmux('show', '-gv', '@wn_wb_tty')]);
	const mainTty = mt.ok ? mt.out.trim() : '';
	const wbTty = wt.ok ? wt.out.trim() : '';
	return {
		main: mainTty ? clients.find(c => c.tty === mainTty) : undefined,
		wb: wbTty ? clients.find(c => c.tty === wbTty) : undefined,
	};
}

export async function listSessions(): Promise<string[]> {
	const r = await tmux('list-sessions', '-F', '#{session_name}');
	return r.ok ? r.out.split('\n').filter(Boolean) : [];
}

export async function hasSession(name: string): Promise<boolean> {
	return (await tmux('has-session', '-t', `=${name}`)).ok;
}

// set の -t は target-pane なので、=<名前>: の形で指す(=<名前> だけでは no such session)
export async function setOpts(session: string, opts: Array<[string, string]>) {
	for (const [k, v] of opts) await tmux('set', '-t', `=${session}:`, k, v);
}

const esc = (s: string) => s.replaceAll('#', '##');

// claude の画面の下の2行(一覧と作業台には出さない)。
// 上: 名前 · 最初の依頼(一覧が @wn_title・@wn_first に置く。最初の依頼を幅で切る)。下: 左に作業台で動いているもの、右にキーの説明
const SUMMARY_FORMAT =
	'#[align=left fg=default]#{=/#{client_width}/…:@wn_title}#[fg=colour245]' +
	'#{?#{&&:#{@wn_first},#{e|<:#{@wn_titlew},#{client_width}}}, · #{=/#{e|-:#{client_width},#{@wn_titlew}}/…:@wn_first},}';
const claudeStatus = (id: string): Array<[string, string]> => [
	['status', '2'],
	['status-format[0]', SUMMARY_FORMAT],
	// 左(作業台の状態)は幅の3分の1まで、右(キーの説明)は残りの幅で切る。右を端末の幅で切ると、左の上に重なって描かれる
	['status-format[1]', '#[align=left]#{T;=/#{e|/:#{client_width},3}/…:status-left}#[align=right]#{T;=/#{e|-:#{e|-:#{client_width},#{e|/:#{client_width},3}},2}/…:status-right}'],
	['status-position', 'bottom'],
	['status-interval', '2'],
	['status-style', 'fg=colour245,bg=default'],
	['status-left-length', '80'],
	['window-status-format', ''],
	['window-status-current-format', ''],
	['window-status-separator', ''],
	['status-right-length', '200'],
	['status-left', `#(${shCall('wb', id)})`],
	['status-right', ATTACH_HELP],
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
	await tmux('set', '-w', '-t', `=${id}:`, 'remain-on-exit', 'off');
	await setOpts(id, [['prefix', 'None'], ['@wn_claude', '1'], ['@wn_id', id], ['@wn_cwd', cwd], ['@wn_name', name], ...claudeStatus(id)]);
	return true;
}

// claude の画面の概要の行に出す、名前と最初の依頼。tmux は値の中の # を書式として読むので ## にする
export async function setSummary(id: string, title: string, first: string | undefined) {
	await setOpts(id, [
		['@wn_title', esc(title)],
		['@wn_titlew', String(stringWidth(title) + 3)],
		['@wn_first', esc(first ?? '')],
	]);
}

// 作業台の画面の端末のタイトル。Ghostty の分割を見分けるのに使う(ghostty.ts)
export const WB_TITLE = 'whatnext workbench';

// 作業台の画面の最下行: `workbench: <名前>  0:zsh* 1:zsh`(キーの説明は出さない)
const workbenchStatus = (name: string): Array<[string, string]> => [
	['set-titles', 'on'],
	['set-titles-string', WB_TITLE],
	['status', 'on'],
	['status-position', 'bottom'],
	['status-style', 'reverse'],
	['status-left', ` workbench: ${esc(name)}  `],
	['status-left-length', '80'],
	['status-right', ''],
];

// 作業台 sh-<id> を作る。作業台の画面が映していなくても作る
export async function createWorkbench(id: string, cwd: string, name: string): Promise<boolean> {
	const r = await tmux('new-session', '-d', '-s', `sh-${id}`, '-c', cwd);
	if (!r.ok) return false;
	await setOpts(`sh-${id}`, [
		['@wn_name', name],
		['@wn_cwd', cwd],
		// 作業台を外から畳んだとき(ctrl+q x で最後のペインを閉じたなど)に、作業台の画面ごと離れないようにする。移った先は一覧が直す
		['detach-on-destroy', 'off'],
		...workbenchStatus(name),
	]);
	return true;
}

export async function setWorkbenchName(id: string, name: string) {
	await setOpts(`sh-${id}`, [
		['@wn_name', name],
		['status-left', ` workbench: ${esc(name)}  `],
	]);
}

// 作業台の画面の案内。作業台がないことと、作ったときの場所を出す
export type Guide = {kind: 'none' | 'tty' | 'no' | 'closed'; id: string; name: string; cwd: string};

export async function ensureGuideSession(): Promise<void> {
	if (await hasSession('wbguide')) return;
	await tmux('new-session', '-d', '-s', 'wbguide', ...keyArgv('guide', 'none', '', '', ''));
	await tmux('set', '-w', '-t', '=wbguide:', 'remain-on-exit', 'off');
	await setOpts('wbguide', [
		['detach-on-destroy', 'off'],
		...workbenchStatus(''),
		['window-status-format', ''],
		['window-status-current-format', ''],
	]);
}

// 案内が今出しているもの(kind, id, cwd)。案内のペインのコマンドが自分で置く
export async function currentGuide(): Promise<{kind: string; id: string; cwd: string} | undefined> {
	const r = await tmux('show', '-gv', '@wn_guide');
	if (!r.ok) return undefined;
	const [kind = '', id = '', cwd = ''] = r.out.replace(/\n$/, '').split('\t');
	return {kind, id, cwd};
}

export async function showGuide(g: Guide): Promise<void> {
	await ensureGuideSession();
	await tmux('respawn-pane', '-k', '-t', '=wbguide:', ...keyArgv('guide', g.kind, g.id, g.name, g.cwd));
}

// 信頼の確認を出すための、対話モードの claude の画面 <name>。claude が終わるとクライアントを一覧へ戻す(KEY_SH)
export async function openTrustSession(name: string, cwd: string): Promise<boolean> {
	const r = await tmux('new-session', '-d', '-s', name, '-c', cwd, ...keyArgv('trust', name));
	if (!r.ok) return false;
	await tmux('set', '-w', '-t', `=${name}:`, 'remain-on-exit', 'off');
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
