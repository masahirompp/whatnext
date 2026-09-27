// The dedicated tmux server: claude attach sessions `<id>` and workbenches `sh-<id>`.
import {run} from './sys.js';
import {PORT} from './receiver.js';

export const SOCKET = process.env.WHATNEXT_TMUX_SOCKET || 'whatnext';
const T = ['-L', SOCKET, '-f', '/dev/null'];

export function tmux(args: string[]) {
	return run('tmux', [...T, ...args], {env: envWithoutTmux()});
}

export function envWithoutTmux(): NodeJS.ProcessEnv {
	const env = {...process.env};
	delete env.TMUX;
	delete env.TMUX_PANE;
	return env;
}

export function tmuxBaseArgs() {
	return [...T];
}

export async function hasTmux(): Promise<boolean> {
	const r = await run('tmux', ['-V']);
	return r.code === 0;
}

export async function sessionNames(): Promise<string[]> {
	const r = await tmux(['list-sessions', '-F', '#{session_name}']);
	if (r.code !== 0) return [];
	return r.stdout.split('\n').filter(Boolean);
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function setupServer() {
	const tm = `tmux -L ${SOCKET}`;
	const popup =
		`${tm} display-popup -c '#{client_tty}' -E -w 90% -h 85% -d '#{@wn_cwd}' ` +
		`"env -u TMUX ${tm} new -A -s 'sh-#{session_name}' -c '#{@wn_cwd}' \\; set prefix C-q" >/dev/null 2>&1; true`;
	// ctrl+q y: ask whatnext for the `!` commands menu of this session (claude screen or workbench)
	const bang =
		`echo '#{session_name} #{client_tty} #{pane_id}' | ` +
		`curl -s -m 2 -o /dev/null --data-binary @- http://127.0.0.1:${PORT}/v1/bang/menu; true`;
	const cmds: string[][] = [
		['start-server'],
		['set', '-g', 'exit-empty', 'off'],
		['set', '-g', 'prefix', 'None'],
		['set', '-g', 'prefix2', 'None'],
		['set', '-g', 'status', 'off'],
		['set', '-s', 'escape-time', '0'],
		['set', '-g', 'focus-events', 'on'],
		['set', '-s', 'extended-keys', 'on'],
		['set', '-as', 'terminal-features', ',*:RGB'],
		['set', '-as', 'terminal-features', ',*:extkeys'],
		['set', '-g', 'default-terminal', 'xterm-256color'],
		['set', '-g', 'history-limit', '20000'],
		['set', '-g', 'set-clipboard', 'on'],
		['set', '-g', 'allow-passthrough', 'on'],
		['set', '-g', 'set-titles', 'off'],
		['bind', '-n', 'C-q', 'switch-client', '-T', 'wnq'],
		['bind', '-T', 'wnq', 'l', 'detach-client'],
		['bind', '-T', 'wnq', 'C-q', 'run-shell', '-b', popup],
		['bind', '-T', 'wnq', 'y', 'run-shell', '-b', bang],
		['bind', '-T', 'prefix', 'C-q', 'detach-client'],
		['bind', '-T', 'prefix', 'y', 'run-shell', '-b', bang],
		['bind', '-T', 'prefix', 'l', 'run-shell', '-b', `${tm} detach-client -s '=#{s/^sh-//:session_name}' >/dev/null 2>&1; true`],
		[
			'set-hook',
			'-g',
			'pane-title-changed',
			`if -F '#{&&:#{@wn_claude},#{m:*claude agents*,#{pane_title}}}' 'kill-session'`,
		],
	];
	const args: string[] = [];
	cmds.forEach((c, i) => {
		if (i) args.push(';');
		args.push(...c);
	});
	return tmux(args);
}

export async function hasSession(name: string) {
	const r = await tmux(['has-session', '-t', `=${name}`]);
	return r.code === 0;
}

/** Prepare the `<id>` session and return the args for the attaching client. */
export async function prepareAttach(id: string, cwd: string, cols: number, rows: number): Promise<string[]> {
	if (!(await hasSession(id))) {
		const script =
			`claude attach ${id}; rc=$?; ` +
			`if [ "$rc" != 0 ]; then printf '\\n\\n[claude attach exited with code %s. Press any key to return to whatnext.]' "$rc"; ` +
			`stty raw -echo 2>/dev/null; dd bs=1 count=1 >/dev/null 2>&1; fi`;
		await tmux([
			'new-session', '-d', '-s', id, '-c', cwd, '-x', String(cols), '-y', String(rows),
			'/bin/sh', '-c', script,
			// within one command list the new session is current; `-t =<id>` is not resolvable yet
			';', 'set', '@wn_claude', '1',
			';', 'set', '@wn_cwd', cwd,
		]);
	}
	return [...T, 'attach-session', '-t', `=${id}`];
}

export function killSession(name: string) {
	return tmux(['kill-session', '-t', `=${name}`]);
}

export async function killAttachAndWorkbench(id: string) {
	await killSession(id);
	await killSession(`sh-${id}`);
}

/** Running (non-shell) command lines per workbench id. */
export async function workbenchRunning(): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	const r = await tmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}']);
	if (r.code !== 0) return out;
	const panes = r.stdout
		.split('\n')
		.filter(Boolean)
		.map(l => l.split('\t') as [string, string])
		.filter(([s]) => s.startsWith('sh-'));
	if (!panes.length) return out;
	const ps = await run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,args=']);
	const procs = ps.stdout
		.split('\n')
		.map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
		.filter((m): m is RegExpMatchArray => !!m)
		.map(m => ({pid: m[1]!, ppid: m[2]!, pgid: m[3]!, args: m[4]!}));
	for (const [sess, panePid] of panes) {
		const id = sess.slice(3);
		const cmds = procs.filter(p => p.ppid === panePid && p.pid === p.pgid).map(p => p.args);
		if (cmds.length) out.set(id, [...(out.get(id) ?? []), ...cmds]);
	}
	return out;
}

/** Close retained attaches and idle workbenches; keep workbenches with running commands. */
export async function closeIdle(): Promise<Map<string, string[]>> {
	const running = await workbenchRunning();
	for (const name of await sessionNames()) {
		if (name.startsWith('sh-') && running.has(name.slice(3))) continue;
		await killSession(name);
	}
	return running;
}

export function killServer() {
	return tmux(['kill-server']);
}

export {q as shellQuote};
