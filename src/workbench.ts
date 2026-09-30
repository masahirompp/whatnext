// 作業台(sh-<id>)で動いているもの。tmux が返すペインのシェルの子を ps で引く。
import {execFile} from 'node:child_process';
import {tmux} from './tmux.js';

const ps = () =>
	new Promise<string>(resolve => {
		execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,args='], {maxBuffer: 16 << 20}, (_e, out) => resolve(String(out ?? '')));
	});

// id → 動いているコマンド行(ペインの順)
export async function runningInWorkbenches(): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	const r = await tmux('list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_dead}');
	if (!r.ok) return out;
	const panes = r.out
		.split('\n')
		.filter(Boolean)
		.map(l => l.split('\t'))
		.filter(([s, , dead]) => s?.startsWith('sh-') && dead !== '1');
	if (panes.length === 0) return out;
	// シェルの子をプロセスグループごとにまとめ、パイプは " | " でつなぐ(ps の並びは pid の順)
	const groups = new Map<string, Map<string, string[]>>();
	for (const line of (await ps()).split('\n')) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (!m) continue;
		const byGroup = groups.get(m[2]!) ?? new Map<string, string[]>();
		byGroup.set(m[3]!, [...(byGroup.get(m[3]!) ?? []), m[4]!.trim()]);
		groups.set(m[2]!, byGroup);
	}
	const children = new Map([...groups].map(([pp, g]) => [pp, [...g.values()].map(cmds => cmds.join(' | '))]));
	for (const [session, pid] of panes) {
		const id = session!.slice(3);
		const cmds = children.get(pid!) ?? [];
		if (!out.has(id)) out.set(id, []);
		out.get(id)!.push(...cmds);
	}
	for (const [id, cmds] of out) if (cmds.length === 0) out.delete(id);
	return out;
}

export async function workbenchIds(): Promise<string[]> {
	const r = await tmux('list-sessions', '-F', '#{session_name}');
	return r.ok ? r.out.split('\n').filter(s => s.startsWith('sh-')).map(s => s.slice(3)) : [];
}

// 作業台と残した claude attach を閉じる
export async function closeFor(id: string): Promise<void> {
	await tmux('kill-session', '-t', `=sh-${id}`);
	await tmux('kill-session', '-t', `=${id}`);
}
