import React, {useEffect, useReducer, useRef} from 'react';
import {Box, Text, useApp, useInput, useWindowSize, type Key} from 'ink';
import {spawn, spawnSync} from 'node:child_process';
import stringWidth from 'string-width';
import cliTruncate from 'cli-truncate';
import {
	buildView,
	canLink,
	deriveTiers,
	descendants,
	displayNames,
	filterCandidates,
	formatDuration,
	formatTokens,
	toSessions,
	updateTracks,
	type Node,
	type RawRow,
	type Session,
	type Tier,
	type Track,
	type Waits,
} from './model.js';
import {bangRoutes, events, launchSettings} from './receiver.js';
import {rowStatus} from './status.js';
import {readTranscript} from './transcript.js';
import {copyText, openMenu, pickFromMenu} from './bang.js';
import {
	ghqList,
	gitWhere,
	isDir,
	expandHome,
	openExternal,
	prFor,
	readAgents,
	readUsage,
	run,
	type UsageItem,
	type Where,
} from './sys.js';
import {
	envWithoutTmux,
	killAttachAndWorkbench,
	killServer,
	killSession,
	prepareAttach,
	workbenchRunning,
} from './tmux.js';

type Panel =
	| {kind: 'hold'; sid: string; text: string}
	| {kind: 'external'; sid: string; sel: number}
	| {kind: 'copy'; sid: string; sel: number}
	| {kind: 'wait'; sid: string; query: string; sel: number}
	| {kind: 'dir'; waiter?: string; query: string; sel: number; cands: string[]}
	| {kind: 'dirOther'; waiter?: string; text: string; error?: string}
	| {kind: 'model'; waiter?: string; dir: string; sel: number}
	| {kind: 'modelOther'; waiter?: string; dir: string; text: string}
	| {kind: 'launching'; dir: string; model?: string; startedAt: number}
	| {kind: 'launchFailed'; output: string}
	| {kind: 'confirm'; text: string; defaultYes: boolean; resolve: (y: boolean) => void}
	| null;

type State = {
	rows: RawRow[];
	sessions: Session[];
	error: string | null;
	loaded: boolean;
	tracks: Map<string, Track>;
	lastRefreshAt: number | null;
	hookSince: Map<string, number>;
	notes: Map<string, string>;
	bang: Map<string, string[]>;
	ctx: Map<string, number>;
	running: Map<string, string[]>;
	where: Map<string, Where>;
	usage: UsageItem[] | null;
	usageStartedAt: number | null;
	usageInFlight: boolean;
	holds: Map<string, string>;
	waits: Waits;
	lastAttached: string | null;
	doneNotices: Map<string, string[]>;
	cursor: string | null;
	panel: Panel;
	message: {text: string; until?: number; color?: string} | null;
	refreshing: boolean;
	deleteArm: {sid: string; at: number; stopping: boolean; pending: boolean} | null;
	attached: boolean;
	busy: boolean;
};

const TIER_COLOR: Record<Tier, string> = {
	Permission: 'red',
	Question: 'yellow',
	Sandbox: 'magenta',
	Failed: 'redBright',
	Review: 'green',
	Working: 'cyan',
	Waiting: 'gray',
};
const PR_COLOR = {open: 'green', draft: 'gray', merged: 'magenta', closed: 'red'} as const;

function pad(s: string, w: number): string {
	const t = stringWidth(s) > w ? cliTruncate(s, w) : s;
	return t + ' '.repeat(Math.max(0, w - stringWidth(t)));
}
function padStart(s: string, w: number): string {
	return ' '.repeat(Math.max(0, w - stringWidth(s))) + s;
}

export function App({launchDir, onQuit}: {launchDir: string; onQuit: () => void}) {
	const [, bump] = useReducer((x: number) => x + 1, 0);
	const {suspendTerminal, exit} = useApp();
	const {columns, rows: termRows} = useWindowSize();
	const st = useRef<State>({
		rows: [],
		sessions: [],
		error: null,
		loaded: false,
		tracks: new Map(),
		lastRefreshAt: null,
		hookSince: new Map(),
		notes: new Map(),
		bang: new Map(),
		ctx: new Map(),
		running: new Map(),
		where: new Map(),
		usage: null,
		usageStartedAt: null,
		usageInFlight: false,
		holds: new Map(),
		waits: new Map(),
		lastAttached: null,
		doneNotices: new Map(),
		cursor: null,
		panel: null,
		message: null,
		refreshing: false,
		deleteArm: null,
		attached: false,
		busy: false,
	}).current;

	const say = (text: string, ms?: number, color?: string) => {
		st.message = {text, until: ms ? Date.now() + ms : undefined, color};
		bump();
	};

	// ---- derived ---------------------------------------------------------
	const derive = () => {
		const tiers = deriveTiers(st.sessions, st.waits);
		const since = new Map<string, number | null>();
		for (const s of st.sessions) {
			const t = tiers.get(s.sessionId);
			if (!t) continue;
			const tr = st.tracks.get(s.sessionId);
			const base = tr && tr.tier === t ? tr.since : st.lastRefreshAt;
			const hook = t === s.tier ? st.hookSince.get(s.sessionId) : undefined;
			since.set(s.sessionId, hook ?? base);
		}
		const view = buildView({
			sessions: st.sessions,
			tiers,
			since,
			waits: st.waits,
			holds: st.holds,
			lastAttached: st.lastAttached,
		});
		const order = [...(view.last ?? []), ...view.ladder, ...view.hold].map(n => n.sid);
		return {tiers, since, view, order};
	};

	const bySid = (sid: string) => st.sessions.find(s => s.sessionId === sid);
	const nameOf = (sid: string) => bySid(sid)?.displayName ?? sid.slice(0, 8);

	const updateDoneNotices = (before: Map<string, Tier | null>, after: Map<string, Tier | null>) => {
		for (const [waiter, targets] of st.waits) {
			const b = before.get(waiter);
			const a = after.get(waiter);
			if (a === 'Waiting') {
				st.doneNotices.delete(waiter);
				continue;
			}
			if (b === 'Waiting' && a && targets.size) {
				st.doneNotices.set(waiter, [...targets]);
			}
		}
		for (const w of [...st.doneNotices.keys()]) if (!st.waits.get(w)?.size) st.doneNotices.delete(w);
	};

	// ---- refresh ----------------------------------------------------------
	const snapshotEvents = () => {
		st.hookSince = new Map();
		st.notes = new Map();
		st.ctx = new Map();
		st.bang = new Map();
		for (const s of st.sessions) {
			if (!s.tier) continue;
			const e = events.get(s.sessionId);
			if (e?.ctx != null) st.ctx.set(s.sessionId, e.ctx);
			const r = rowStatus(s.tier, e, readTranscript(s.sessionId));
			if (r.since != null) st.hookSince.set(s.sessionId, r.since);
			if (r.note) st.notes.set(s.sessionId, r.note);
			if (r.bang.length) st.bang.set(s.sessionId, r.bang);
		}
	};

	/** `!` commands of a session as of now (for `ctrl+q y` while attached). */
	const commandsNow = async (id: string): Promise<string[]> => {
		let s = st.sessions.find(x => x.id === id);
		try {
			s = toSessions(await readAgents()).find(x => x.id === id) ?? s;
		} catch {}
		if (!s) return [];
		return rowStatus(s.tier, events.get(s.sessionId), readTranscript(s.sessionId)).bang;
	};

	const copyCommand = async (cmd: string) => {
		await copyText(cmd);
		say(`Copied: ${cmd}`, 4000);
	};

	const fetchWhere = (sessions: Session[]) => {
		const cwds = [...new Set(sessions.filter(s => s.tier).map(s => s.cwd))];
		for (const cwd of cwds) {
			void (async () => {
				const w = await gitWhere(cwd);
				const prev = st.where.get(cwd);
				st.where.set(cwd, {...w, pr: prev?.branch === w.branch ? prev?.pr : undefined});
				bump();
				const pr = await prFor(w);
				st.where.set(cwd, {...w, pr});
				bump();
			})();
		}
	};

	// Initial fetch always runs; after attach / refresh key, skip while one is in flight
	// or within 60s of the previous fetch's start.
	const refreshUsage = (force = false) => {
		const now = Date.now();
		if (!force && (st.usageInFlight || (st.usageStartedAt && now - st.usageStartedAt < 60000))) return;
		st.usageInFlight = true;
		st.usageStartedAt = now;
		void readUsage().then(u => {
			st.usageInFlight = false;
			if (u) st.usage = u;
			bump();
		});
	};

	const refresh = async (reason: 'initial' | 'auto' | 'key' | 'attach') => {
		st.refreshing = true;
		bump();
		const before = derive().tiers;
		try {
			st.rows = await readAgents();
			st.error = null;
		} catch (e: any) {
			st.rows = [];
			st.sessions = [];
			st.error = String(e?.message ?? e);
			st.refreshing = false;
			st.loaded = true;
			st.lastRefreshAt = Date.now();
			bump();
			return;
		}
		const now = Date.now();
		st.sessions = toSessions(st.rows);
		const present = new Set(st.rows.map(r => r.sessionId));
		for (const [w, ts] of [...st.waits]) {
			if (!present.has(w)) {
				st.waits.delete(w);
				continue;
			}
			for (const t of [...ts]) if (!present.has(t)) ts.delete(t);
			if (!ts.size) st.waits.delete(w);
		}
		const tiers = deriveTiers(st.sessions, st.waits);
		for (const sid of [...st.holds.keys()]) if (!tiers.get(sid)) st.holds.delete(sid);
		st.tracks = updateTracks(st.tracks, tiers, st.lastRefreshAt);
		st.lastRefreshAt = now;
		if (st.loaded) updateDoneNotices(before, tiers);
		snapshotEvents();
		st.running = await workbenchRunning();
		st.loaded = true;
		st.refreshing = false;
		if (reason === 'key') say('Refreshed.', 2000);
		fetchWhere(st.sessions);
		bump();
	};

	// ---- cursor -----------------------------------------------------------
	const ensureCursor = () => {
		const {order, view} = derive();
		if (!st.cursor || !order.includes(st.cursor)) st.cursor = view.topPick ?? order[0] ?? null;
	};

	// ---- attach -----------------------------------------------------------
	const attachTo = async (target: {id: string; cwd: string; sessionId: string}) => {
		const before = st.rows.find(r => r.sessionId === target.sessionId);
		// "worked" = the --json state changed, a UserPromptSubmit hook came, or the
		// transcript gained user / assistant rows (OTel events do not count)
		const pre = {
			state: before?.state,
			status: before?.status,
			waitingFor: before?.waitingFor,
			prompts: events.get(target.sessionId)?.prompts ?? 0,
			lastKey: readTranscript(target.sessionId)?.lastKey,
		};
		st.attached = true;
		st.message = null;
		const noop = () => {};
		const sigs: NodeJS.Signals[] = ['SIGINT', 'SIGTSTP', 'SIGQUIT'];
		await suspendTerminal(async () => {
			await new Promise(r => setImmediate(r));
			const stdin = process.stdin as any;
			const listeners = stdin.listeners('readable');
			for (const l of listeners) stdin.removeListener('readable', l);
			if (stdin._handle) {
				stdin._handle.reading = false;
				stdin._handle.readStop?.();
			}
			for (const s of sigs) process.on(s, noop);
			const saved = spawnSync('stty', ['-g'], {stdio: ['inherit', 'pipe', 'pipe']}).stdout?.toString().trim();
			try {
				const args = await prepareAttach(target.id, target.cwd, process.stdout.columns || 120, process.stdout.rows || 40);
				await new Promise<void>(resolve => {
					const c = spawn('tmux', args, {stdio: 'inherit', env: envWithoutTmux()});
					c.on('exit', () => resolve());
					c.on('error', () => resolve());
				});
			} finally {
				if (saved) spawnSync('stty', [saved], {stdio: ['inherit', 'pipe', 'pipe']});
				// Ink re-enters the alternate screen at the saved cursor position; start from the top.
				// tmux leaves "[detached (from session …)]" / "[exited]" on the main screen; erase that line.
				process.stdout.write('\x1b[1A\x1b[2K\x1b[H');
				for (const s of sigs) process.removeListener(s, noop);
				if (stdin._readableState) stdin._readableState.reading = false;
				for (const l of listeners) stdin.on('readable', l);
				stdin.read(0);
			}
		});
		st.attached = false;
		st.lastAttached = target.sessionId;
		st.doneNotices.delete(target.sessionId);
		st.cursor = target.sessionId;
		refreshUsage();
		await refresh('attach');
		if (st.holds.has(target.sessionId)) {
			const after = st.rows.find(r => r.sessionId === target.sessionId);
			const worked =
				!after ||
				after.state !== pre.state ||
				after.status !== pre.status ||
				after.waitingFor !== pre.waitingFor ||
				(events.get(target.sessionId)?.prompts ?? 0) > pre.prompts ||
				readTranscript(target.sessionId)?.lastKey !== pre.lastKey;
			if (worked) st.holds.delete(target.sessionId);
		}
		const {order, view} = derive();
		st.cursor = order.includes(target.sessionId) ? target.sessionId : (view.ladder[0]?.sid ?? order[0] ?? null);
		bump();
	};

	// ---- confirm ----------------------------------------------------------
	const ask = (text: string, defaultYes = false) =>
		new Promise<boolean>(resolve => {
			st.panel = {kind: 'confirm', text, defaultYes, resolve};
			bump();
		});

	// ---- delete -----------------------------------------------------------
	const waitNoProcess = async (sid: string) => {
		for (let i = 0; i < 20; i++) {
			try {
				const rows = await readAgents();
				const r = rows.find(x => x.sessionId === sid && x.kind === 'background');
				if (!r || r.pid == null) return;
			} catch {
				return;
			}
			await new Promise(r => setTimeout(r, 500));
		}
	};

	const rmOne = async (s: Session): Promise<boolean> => {
		const id = s.id!;
		const running = (await workbenchRunning()).get(id);
		if (running?.length) {
			const ok = await ask(`${s.displayName}: the workbench is running ${running.join(', ')}. Stop it and delete the session? [y/N]`);
			if (!ok) {
				say(`Kept ${s.displayName}.`);
				return false;
			}
		}
		say(`Deleting ${s.displayName}...`);
		await waitNoProcess(s.sessionId);
		for (let attempt = 0; attempt < 10; attempt++) {
			const r = await run('claude', ['rm', id]);
			const out = (r.stdout + '\n' + r.stderr).trim();
			if (r.code === 0) {
				await killAttachAndWorkbench(id);
				return true;
			}
			const m = out.match(/--discard-unpushed\s+(\S+)/);
			if (m) {
				const n = out.match(/(\d+) unpushed commit/)?.[1] ?? '1';
				const ok = await ask(`Discard ${n} unpushed commit${n === '1' ? '' : 's'} and delete session ${id}? [y/N]`);
				if (!ok) {
					say(`Kept ${s.displayName}.`);
					return false;
				}
				const r2 = await run('claude', ['rm', id, '--discard-unpushed', m[1]!.replace(/[.,;]+$/, '')]);
				if (r2.code === 0) {
					await killAttachAndWorkbench(id);
					return true;
				}
				say((r2.stdout + r2.stderr).trim() || `claude rm exited with ${r2.code}`, undefined, 'red');
				return false;
			}
			if (/lock|still running|in use|process/i.test(out) && attempt < 9) {
				await new Promise(r => setTimeout(r, 1000));
				continue;
			}
			say(out || `claude rm exited with ${r.code}`, undefined, 'red');
			return false;
		}
		return false;
	};

	const deleteFlow = async (sid: string) => {
		const s = bySid(sid);
		if (!s?.id) return;
		st.busy = true;
		const present = new Set(st.rows.map(r => r.sessionId));
		const targets = descendants(st.waits, sid).filter(x => present.has(x));
		let cascade = false;
		if (targets.length) {
			const names = targets.map(nameOf);
			cascade = await ask(
				`Also delete ${targets.length} session${targets.length === 1 ? '' : 's'} this one was waiting for? (${names.join(', ')}) [y/N]`,
			);
		}
		const ok = await rmOne(s);
		if (ok) {
			say(`Deleted ${s.displayName}.`, 4000);
			if (cascade) {
				for (const t of targets) {
					const ts = bySid(t);
					if (!ts?.id) continue;
					if (ts.pid != null) await run('claude', ['stop', ts.id]);
					const ok2 = await rmOne(ts);
					if (ok2) say(`Deleted ${ts.displayName}.`, 4000);
				}
			}
		}
		st.busy = false;
		await refresh('auto');
		ensureCursor();
		bump();
	};

	const ctrlX = async (sid: string) => {
		const s = bySid(sid);
		if (!s) return;
		if (!s.id) {
			say('Interactive sessions cannot be stopped from whatnext.', 3000);
			return;
		}
		const arm = st.deleteArm;
		const now = Date.now();
		if (arm && arm.sid === sid && (arm.stopping || now - arm.at <= 2000)) {
			if (arm.stopping) {
				arm.pending = true;
				say(`Stopping ${s.displayName}... it will be deleted.`);
				return;
			}
			st.deleteArm = null;
			await deleteFlow(sid);
			return;
		}
		st.deleteArm = {sid, at: now, stopping: true, pending: false};
		say(`Stopping ${s.displayName}... (Ctrl+X again to delete)`);
		await run('claude', ['stop', s.id]);
		await killSession(s.id);
		const a = st.deleteArm as State['deleteArm'];
		if (!a || a.sid !== sid) return;
		a.stopping = false;
		if (a.pending) {
			st.deleteArm = null;
			await deleteFlow(sid);
			return;
		}
		say(`Stopped ${s.displayName}. Press Ctrl+X again within 2s to delete.`, 2000);
		setTimeout(() => {
			if (st.deleteArm === a) {
				st.deleteArm = null;
				void refresh('auto').then(() => {
					ensureCursor();
					bump();
				});
			}
		}, Math.max(0, a.at + 2000 - Date.now()) + 50);
	};

	// ---- new session -------------------------------------------------------
	const dirCandidates = async (waiter?: string): Promise<string[]> => {
		const out: string[] = [];
		const add = (p: string | undefined) => {
			if (p && !out.includes(p)) out.push(p);
		};
		if (waiter) {
			const w = bySid(waiter);
			if (w) add(st.where.get(w.cwd)?.repoRoot ?? (await gitWhere(w.cwd)).repoRoot);
		}
		add(launchDir);
		for (const cwd of [...new Set(st.rows.map(r => r.cwd))]) {
			add(st.where.get(cwd)?.repoRoot ?? (await gitWhere(cwd)).repoRoot);
		}
		for (const p of await ghqList()) add(p);
		return out;
	};

	const openDirPanel = async (waiter?: string) => {
		st.panel = {kind: 'dir', waiter, query: '', sel: 0, cands: []};
		bump();
		const cands = await dirCandidates(waiter);
		if (st.panel?.kind === 'dir') {
			st.panel.cands = cands;
			bump();
		}
	};

	const launch = async (dir: string, model: string | undefined, waiter?: string) => {
		st.panel = {kind: 'launching', dir, model, startedAt: Date.now()};
		bump();
		const t = setInterval(bump, 1000);
		const args = ['--bg', ...(model ? ['--model', model] : []), '--settings', launchSettings()];
		const r = await run('claude', args, {cwd: dir, timeout: 180000});
		clearInterval(t);
		const out = (r.stdout + '\n' + r.stderr).replace(/\x1b\[[0-9;]*m/g, '').trim();
		const m = out.match(/backgrounded\s*·\s*([0-9a-zA-Z]+)/);
		if (!m) {
			st.panel = {kind: 'launchFailed', output: out || `claude --bg exited with ${r.code}`};
			bump();
			return;
		}
		const id = m[1]!;
		let sid = id;
		try {
			const rows = await readAgents();
			sid = rows.find(x => x.id === id)?.sessionId ?? id;
		} catch {}
		if (waiter && sid !== id) {
			const before = derive().tiers;
			if (canLink(st.waits, waiter, sid)) {
				if (!st.waits.has(waiter)) st.waits.set(waiter, new Set());
				st.waits.get(waiter)!.add(sid);
			}
			updateDoneNotices(before, derive().tiers);
		}
		st.panel = null;
		bump();
		await attachTo({id, cwd: dir, sessionId: sid});
	};

	// ---- quit --------------------------------------------------------------
	const quit = async () => {
		const running = await workbenchRunning();
		if (running.size) {
			const items = [...running].flatMap(([id, cmds]) => {
				const s = st.sessions.find(x => x.id === id);
				return cmds.map(c => `${s?.displayName ?? id}: ${c}`);
			});
			const n = items.length;
			const ok = await ask(`Quit and stop ${n} running command${n === 1 ? '' : 's'}? ${items.join(', ')} [y/N]`);
			if (!ok) {
				bump();
				return;
			}
		}
		await killServer();
		onQuit();
		exit();
	};

	// ---- lifecycle ---------------------------------------------------------
	useEffect(() => {
		bangRoutes.menu = body => void openMenu(body, commandsNow);
		bangRoutes.pick = body => void pickFromMenu(body);
		void refresh('initial').then(() => {
			ensureCursor();
			bump();
		});
		refreshUsage(true);
		const iv = setInterval(() => {
			if (st.attached || st.refreshing || st.busy || st.deleteArm) return;
			if (st.lastRefreshAt && Date.now() - st.lastRefreshAt >= 60000) {
				void refresh('auto').then(() => {
					ensureCursor();
					bump();
				});
				return;
			}
			if (st.message?.until && Date.now() > st.message.until) {
				st.message = null;
				bump();
			}
		}, 1000);
		const iv2 = setInterval(() => !st.attached && bump(), 15000);
		return () => {
			clearInterval(iv);
			clearInterval(iv2);
		};
	}, []);

	// ---- input -------------------------------------------------------------
	const editText = (text: string, input: string, key: Key): string | null => {
		if (key.backspace || key.delete) return text.slice(0, -1);
		if (key.ctrl || key.meta || key.escape || key.return || key.upArrow || key.downArrow || key.tab) return null;
		if (!input) return null;
		return text + input.replace(/[\r\n]+/g, '');
	};

	useInput((input, key) => {
		if (st.attached) return;
		const p = st.panel;
		const {order, view} = derive();
		const cur = st.cursor && order.includes(st.cursor) ? st.cursor : null;

		if (p?.kind === 'launching') return;
		if (p?.kind === 'launchFailed') {
			st.panel = null;
			void refresh('auto').then(() => {
				ensureCursor();
				bump();
			});
			return;
		}
		if (p?.kind === 'confirm') {
			let ans: boolean | null = null;
			if (input === 'y' || input === 'Y') ans = true;
			else if (input === 'n' || input === 'N' || key.escape) ans = false;
			else if (key.return) ans = p.defaultYes;
			if (ans === null) return;
			st.panel = null;
			bump();
			p.resolve(ans);
			return;
		}
		if (p?.kind === 'hold') {
			if (key.escape) {
				st.panel = null;
				bump();
				return;
			}
			if (key.return) {
				const idx = order.indexOf(p.sid);
				st.holds.set(p.sid, p.text.trim());
				st.panel = null;
				// skip the rows that moved to the hold group together with this one
				const moved = new Set(derive().view.hold.map(n => n.sid));
				const ok = (x: string) => x !== p.sid && !moved.has(x);
				st.cursor = order.slice(idx + 1).find(ok) ?? order.slice(0, idx).reverse().find(ok) ?? p.sid;
				say(`Put ${nameOf(p.sid)} on hold. It comes back when you attach and work on it, or press h on it.`, 6000);
				return;
			}
			const t = editText(p.text, input, key);
			if (t !== null) {
				p.text = t;
				bump();
			}
			return;
		}
		if (p?.kind === 'copy') {
			const cmds = st.bang.get(p.sid) ?? [];
			if (key.escape || !cmds.length) {
				st.panel = null;
				bump();
				return;
			}
			if (key.upArrow) p.sel = Math.max(0, p.sel - 1);
			else if (key.downArrow) p.sel = Math.min(cmds.length - 1, p.sel + 1);
			else if (/^[1-9]$/.test(input) && Number(input) <= cmds.length) {
				p.sel = Number(input) - 1;
				key = {...key, return: true};
			}
			if (key.return) {
				const cmd = cmds[p.sel];
				st.panel = null;
				if (cmd != null) void copyCommand(cmd);
			}
			bump();
			return;
		}
		if (p?.kind === 'external') {
			const items = externalItems(p.sid);
			if (key.escape) {
				st.panel = null;
				bump();
				return;
			}
			if (key.upArrow) p.sel = Math.max(0, p.sel - 1);
			else if (key.downArrow) p.sel = Math.min(items.length - 1, p.sel + 1);
			else if (/^[1-9]$/.test(input) && Number(input) <= items.length) {
				p.sel = Number(input) - 1;
				key = {...key, return: true};
			}
			if (key.return) {
				const it = items[p.sel];
				st.panel = null;
				if (it)
					void openExternal(it.target).then(r => {
						if (r.code === 0) say(`Opened ${it.label}.`, 4000);
						else say((r.stdout + r.stderr).trim() || `open exited with ${r.code}`, undefined, 'red');
					});
			}
			bump();
			return;
		}
		if (p?.kind === 'wait') {
			const items = waitItems(p.sid, p.query);
			if (key.escape) {
				st.panel = null;
				bump();
				return;
			}
			if (key.upArrow) p.sel = Math.max(0, p.sel - 1);
			else if (key.downArrow) p.sel = Math.min(items.length - 1, p.sel + 1);
			else if (key.return) {
				const it = items[p.sel];
				if (!it) return;
				if (it.kind === 'new') {
					void openDirPanel(p.sid);
					return;
				}
				const before = derive().tiers;
				const set = st.waits.get(p.sid) ?? new Set<string>();
				if (set.has(it.sid)) {
					set.delete(it.sid);
					say(`${nameOf(p.sid)} no longer waits for ${nameOf(it.sid)}.`, 4000);
				} else {
					set.add(it.sid);
					say(`${nameOf(p.sid)} now waits for ${nameOf(it.sid)}.`, 4000);
				}
				if (set.size) st.waits.set(p.sid, set);
				else st.waits.delete(p.sid);
				updateDoneNotices(before, derive().tiers);
				st.panel = null;
			} else {
				const t = editText(p.query, input, key);
				if (t !== null) {
					p.query = t;
					// typing filters the existing sessions; select the first match
					p.sel = t && waitItems(p.sid, t).length > 1 ? 1 : 0;
				}
			}
			bump();
			return;
		}
		if (p?.kind === 'dir') {
			const items = dirItems(p);
			if (key.escape) {
				st.panel = null;
				bump();
				return;
			}
			if (key.upArrow) p.sel = Math.max(0, p.sel - 1);
			else if (key.downArrow) p.sel = Math.min(items.length - 1, p.sel + 1);
			else if (key.return) {
				const it = items[p.sel];
				if (!it) return;
				if (it.other) st.panel = {kind: 'dirOther', waiter: p.waiter, text: p.query};
				else st.panel = {kind: 'model', waiter: p.waiter, dir: it.path, sel: 0};
			} else {
				const t = editText(p.query, input, key);
				if (t !== null) {
					p.query = t;
					p.sel = 0;
				}
			}
			bump();
			return;
		}
		if (p?.kind === 'dirOther') {
			if (key.escape) {
				st.panel = null;
				bump();
				return;
			}
			if (key.return) {
				const raw = p.text.trim();
				const dir = raw ? expandHome(raw) : launchDir;
				if (!isDir(dir)) {
					p.error = `Not a directory: ${dir}`;
					bump();
					return;
				}
				st.panel = {kind: 'model', waiter: p.waiter, dir, sel: 0};
				bump();
				return;
			}
			const t = editText(p.text, input, key);
			if (t !== null) {
				p.text = t;
				p.error = undefined;
				bump();
			}
			return;
		}
		if (p?.kind === 'model') {
			if (key.escape) {
				st.panel = null;
				bump();
				return;
			}
			if (key.upArrow || key.downArrow) p.sel = p.sel ? 0 : 1;
			else if (key.return) {
				if (p.sel === 0) void launch(p.dir, undefined, p.waiter);
				else st.panel = {kind: 'modelOther', waiter: p.waiter, dir: p.dir, text: ''};
			}
			bump();
			return;
		}
		if (p?.kind === 'modelOther') {
			if (key.escape) {
				st.panel = {kind: 'model', waiter: p.waiter, dir: p.dir, sel: 1};
				bump();
				return;
			}
			if (key.return) {
				if (p.text.trim()) void launch(p.dir, p.text.trim(), p.waiter);
				return;
			}
			const t = editText(p.text, input, key);
			if (t !== null) {
				p.text = t;
				bump();
			}
			return;
		}

		// ---- list mode ----
		if (st.busy) return;
		const isCtrlX = key.ctrl && input === 'x';
		if (!isCtrlX && st.deleteArm && !st.deleteArm.stopping) {
			st.deleteArm = null;
			if (key.escape) {
				say('Cancelled.', 1500);
				void refresh('auto').then(() => {
					ensureCursor();
					bump();
				});
				return;
			}
		}
		if (key.upArrow || input === 'k') {
			const i = cur ? order.indexOf(cur) : 0;
			st.cursor = order[Math.max(0, i - 1)] ?? null;
			bump();
			return;
		}
		if (key.downArrow || input === 'j') {
			const i = cur ? order.indexOf(cur) : -1;
			st.cursor = order[Math.min(order.length - 1, i + 1)] ?? null;
			bump();
			return;
		}
		if (input === 'q' || (key.ctrl && input === 'c')) {
			void quit();
			return;
		}
		if (input === 'r') {
			refreshUsage();
			void refresh('key').then(() => {
				ensureCursor();
				bump();
			});
			return;
		}
		if (input === 'n') {
			void openDirPanel();
			return;
		}
		if (!cur) return;
		const s = bySid(cur)!;
		if (key.return) {
			if (s.kind === 'interactive' || !s.id) {
				say(`${s.displayName} is an interactive session and cannot be attached. cwd: ${s.cwd} · pid: ${s.pid ?? '-'}`);
				return;
			}
			void attachTo({id: s.id, cwd: s.cwd, sessionId: s.sessionId});
			return;
		}
		if (isCtrlX) {
			void ctrlX(cur);
			return;
		}
		if (input === 'h') {
			if (st.holds.has(cur)) {
				st.holds.delete(cur);
				say(`${s.displayName} is back in the list.`, 4000);
				return;
			}
			st.panel = {kind: 'hold', sid: cur, text: ''};
			bump();
			return;
		}
		if (input === 'c') {
			const cmds = st.bang.get(cur) ?? [];
			if (cmds.length === 1) void copyCommand(cmds[0]!);
			else if (cmds.length > 1) {
				st.panel = {kind: 'copy', sid: cur, sel: 0};
				bump();
			}
			return;
		}
		if (input === 'e') {
			st.panel = {kind: 'external', sid: cur, sel: 0};
			bump();
			return;
		}
		if (input === 'w') {
			st.panel = {kind: 'wait', sid: cur, query: '', sel: 0};
			bump();
			return;
		}
		void view;
	});

	// ---- menu items --------------------------------------------------------
	function externalItems(sid: string) {
		const s = bySid(sid);
		if (!s) return [];
		const w = st.where.get(s.cwd);
		const items: {label: string; target: string}[] = [];
		const pr = w?.pr;
		if (pr) items.push({label: `PR #${pr.number} on GitHub`, target: pr.url});
		const root = w?.checkoutRoot ?? s.cwd;
		items.push({label: `VS Code (${root})`, target: `vscode://file${root}/`});
		const gm = pr?.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
		if (pr && gm) items.push({label: `PR #${pr.number} on vscode.dev`, target: `https://vscode.dev/github/${gm[1]}/${gm[2]}/pull/${gm[3]}`});
		return items;
	}

	type WaitItem = {kind: 'new'} | {kind: 'session'; sid: string; linked: boolean};
	function waitItems(waiter: string, query: string): WaitItem[] {
		const {tiers} = derive();
		const linked = st.waits.get(waiter) ?? new Set<string>();
		const cands = st.sessions.filter(
			s => s.sessionId !== waiter && (linked.has(s.sessionId) || (tiers.get(s.sessionId) && canLink(st.waits, waiter, s.sessionId))),
		);
		const filtered = filterCandidates(
			cands,
			query,
			s => s.displayName,
			s => `${s.displayName} ${s.cwd}`,
		);
		return [{kind: 'new'}, ...filtered.map(s => ({kind: 'session' as const, sid: s.sessionId, linked: linked.has(s.sessionId)}))];
	}

	function dirItems(p: Extract<Panel, {kind: 'dir'}>) {
		const names = displayNames(p.cands);
		const filtered = filterCandidates(p.cands, p.query, x => names.get(x) ?? x, x => x);
		return [...filtered.map(path => ({path, label: names.get(path) ?? path, other: false})), {path: '', label: 'Other...', other: true}];
	}

	// ---- render ------------------------------------------------------------
	ensureCursor();
	const {tiers, since, view, order} = derive();
	const width = Math.max(40, columns || 80);
	const now = Date.now();

	type Cells = {name: string; status: string; statusColor: string; where: Where | undefined; wtext: string; ctx: string; wait: string};
	const cellsOf = (n: Node): Cells => {
		const s = bySid(n.sid)!;
		const t = tiers.get(n.sid)!;
		const w = st.where.get(s.cwd);
		let wtext = w ? w.repo : '';
		if (w?.branch) wtext += ` ${w.branch}`;
		if (w?.worktree) wtext += ' (wt)';
		const reason = t === s.tier ? s.reason : undefined;
		const sn = since.get(n.sid);
		return {
			name: `${n.prefix}${s.displayName}${s.kind === 'interactive' ? ' (tty)' : ''}${n.heldInTree ? ' (on hold)' : ''}`,
			status: reason ? `${t} (${reason})` : t,
			statusColor: TIER_COLOR[t],
			where: w,
			wtext,
			ctx: formatTokens(st.ctx.get(n.sid)),
			wait: formatDuration(sn == null ? null : now - sn),
		};
	};
	const allNodes = [...(view.last ?? []), ...view.ladder, ...view.hold];
	const cells = new Map(allNodes.map(n => [n.sid, cellsOf(n)]));
	const prText = (w?: Where) => (w?.pr ? ` #${w.pr.number} (${w.pr.state})` : '');
	const nameW = Math.min(36, Math.max(7, ...[...cells.values()].map(c => stringWidth(c.name)))) + 2;
	const statusW = Math.max(6, ...[...cells.values()].map(c => stringWidth(c.status)));
	const ctxW = 5;
	const waitW = 7;
	const whereMax = Math.max(5, ...[...cells.values()].map(c => stringWidth(c.wtext + prText(c.where))));
	const whereW = Math.max(5, Math.min(whereMax, width - nameW - statusW - ctxW - waitW - 8));

	type Line = {key: string; sid?: string; row?: boolean; el: React.ReactNode};
	const rowLines = (n: Node): Line[] => {
		const c = cells.get(n.sid)!;
		const sel = n.sid === st.cursor;
		const w = c.where;
		const whereFull = c.wtext + prText(w);
		let whereEl: React.ReactNode;
		if (stringWidth(whereFull) > whereW || !w?.pr) whereEl = <Text>{pad(whereFull, whereW)}</Text>;
		else
			whereEl = (
				<Text>
					{c.wtext}
					<Text color={PR_COLOR[w.pr.state]}>{prText(w)}</Text>
					{' '.repeat(whereW - stringWidth(whereFull))}
				</Text>
			);
		const lines: Line[] = [
			{
				key: `r-${n.sid}`,
				sid: n.sid,
				row: true,
				el: (
					<Text wrap="truncate-end">
						<Text color={sel ? 'cyanBright' : undefined} bold={sel}>
							{sel ? '> ' : '  '}
							{pad(c.name, nameW - 2)}
						</Text>
						{'  '}
						<Text color={c.statusColor}>{pad(c.status, statusW)}</Text>
						{'  '}
						{whereEl}
						{'  '}
						<Text dimColor={c.ctx === '-'}>{padStart(c.ctx, ctxW)}</Text>
						{'  '}
						<Text dimColor={c.wait === '-'}>{padStart(c.wait, waitW)}</Text>
					</Text>
				),
			},
		];
		const indent = '  ' + n.notePrefix + '  ';
		const noteLine = (k: string, text: string, color?: string) =>
			lines.push({
				key: `${k}-${n.sid}`,
				sid: n.sid,
				el: (
					<Text wrap="truncate-end">
						<Text dimColor>{indent}</Text>
						<Text color={color} dimColor={!color}>
							{text}
						</Text>
					</Text>
				),
			});
		const note = st.notes.get(n.sid);
		if (note) noteLine('n', note);
		const bang = st.bang.get(n.sid);
		if (bang?.length) noteLine('b', `! ${bang.join(' · ')}`, 'cyan');
		const s = bySid(n.sid)!;
		const running = s.id ? st.running.get(s.id) : undefined;
		if (running?.length) noteLine('g', `⚙ ${running.join(' · ')}`, 'yellow');
		const done = st.doneNotices.get(n.sid);
		if (done?.length) noteLine('d', `↳ ${done.map(nameOf).join(', ')} done`, 'green');
		const reason = st.holds.get(n.sid);
		if (reason) noteLine('h', `↳ ${reason}`, 'gray');
		return lines;
	};

	const header: Line[] = [];
	header.push({
		key: 'title',
		el: (
			<Text wrap="truncate-end">
				<Text bold>whatnext</Text>
				{st.usage ? '  ' : ''}
				{(st.usage ?? []).map((u, i) => (
					<Text key={u.label}>
						{i ? ' · ' : ''}
						{u.label} <Text color={u.percent >= 80 ? 'red' : u.percent >= 50 ? 'yellow' : undefined}>{u.percent}%</Text>
						{u.resets ? ` (resets ${u.resets})` : ''}
					</Text>
				))}
			</Text>
		),
	});
	const hasRows = allNodes.length > 0;
	if (hasRows)
		header.push({
			key: 'cols',
			el: (
				<Text dimColor wrap="truncate-end">
					{'  '}
					{pad('SESSION', nameW - 2)}
					{'  '}
					{pad('STATUS', statusW)}
					{'  '}
					{pad('WHERE', whereW)}
					{'  '}
					{padStart('CTX', ctxW)}
					{'  '}
					{padStart('WAITING', waitW)}
				</Text>
			),
		});
	const fixed: Line[] = [];
	if (view.last) {
		fixed.push({key: 'h-last', el: <Text bold>Last attached</Text>});
		for (const n of view.last) fixed.push(...rowLines(n));
	}
	if (view.last || view.hold.length) {
		if (view.last) fixed.push({key: 'b-last', el: <Text> </Text>});
		fixed.push({key: 'h-next', el: <Text bold>Up next</Text>});
	}
	const scroll: Line[] = [];
	for (const n of view.ladder) scroll.push(...rowLines(n));
	if (view.hold.length) {
		scroll.push({key: 'b-hold', el: <Text> </Text>});
		scroll.push({key: 'h-hold', el: <Text bold>On hold</Text>});
		for (const n of view.hold) scroll.push(...rowLines(n));
	}

	// bottom area
	const bottom: Line[] = [];
	const msgText = st.refreshing ? 'refreshing...' : st.message?.text;
	if (st.error) bottom.push({key: 'err', el: <Text color="red" wrap="wrap">Failed to read sessions: {st.error}</Text>});
	else if (st.loaded && !hasRows) bottom.push({key: 'empty', el: <Text dimColor>No sessions to show.</Text>});
	if (msgText) bottom.push({key: 'msg', el: <Text color={st.refreshing ? 'gray' : st.message?.color} wrap="wrap">{msgText}</Text>});
	const p = st.panel;
	const menu = (items: {label: string; mark?: string}[], sel: number, max = 8, pinLast = false) => {
		const body = pinLast ? items.slice(0, -1) : items;
		const bmax = pinLast ? max - 1 : max;
		const start = Math.max(0, Math.min(sel - Math.floor(bmax / 2), body.length - bmax));
		const idxs = body.slice(start, start + bmax).map((_, i) => start + i);
		if (pinLast) idxs.push(items.length - 1);
		return idxs.map(idx => {
			const it = items[idx]!;
			return {
				key: `m-${idx}`,
				el: (
					<Text wrap="truncate-end" color={idx === sel ? 'cyanBright' : undefined}>
						{idx === sel ? '> ' : '  '}
						{it.mark ?? ''}
						{it.label}
					</Text>
				),
			};
		});
	};
	const curHasBang = !!(st.cursor && st.bang.get(st.cursor)?.length);
	let help = `↑↓ move · enter attach · ${curHasBang ? 'c copy ! commands · ' : ''}n new · w wait for · h hold · e external · ^X stop/delete · r refresh · q quit · ^Q^Q workbench · ^Q l back · ^Q y ! commands`;
	if (p?.kind === 'hold') {
		bottom.push({key: 'hold', el: <Text wrap="truncate-end">Put {nameOf(p.sid)} on hold. Reason (optional): {p.text}<Text inverse> </Text></Text>});
		help = 'enter confirm · esc cancel';
	} else if (p?.kind === 'copy') {
		const cmds = st.bang.get(p.sid) ?? [];
		bottom.push({key: 'cp', el: <Text bold>Copy ! commands from {nameOf(p.sid)}:</Text>});
		bottom.push(...menu(cmds.map((c, i) => ({label: `${i + 1} ${c}`})), p.sel, 9));
		help = '↑↓ select · enter/1-9 copy · esc close';
	} else if (p?.kind === 'external') {
		const items = externalItems(p.sid);
		bottom.push({key: 'ext', el: <Text bold>Show {nameOf(p.sid)} in:</Text>});
		bottom.push(...menu(items.map((it, i) => ({label: `${i + 1}. ${it.label}`})), p.sel));
		const s = bySid(p.sid);
		if (s && !st.where.get(s.cwd)?.pr) bottom.push({key: 'nopr', el: <Text dimColor>  No PR for this session.</Text>});
		help = '↑↓ select · enter/1-9 open · esc close';
	} else if (p?.kind === 'wait') {
		const items = waitItems(p.sid, p.query);
		bottom.push({key: 'wt', el: <Text wrap="truncate-end"><Text bold>{nameOf(p.sid)} waits for:</Text> {p.query}<Text inverse> </Text></Text>});
		bottom.push(
			...menu(
				items.map(it =>
					it.kind === 'new'
						? {label: 'New session'}
						: {label: `${nameOf(it.sid)}  ${st.where.get(bySid(it.sid)!.cwd)?.repo ?? ''}`, mark: it.linked ? '✓ ' : '  '},
				),
				p.sel,
			),
		);
		help = 'type to filter · ↑↓ select · enter add/remove · esc close';
	} else if (p?.kind === 'dir') {
		const items = dirItems(p);
		bottom.push({key: 'dt', el: <Text wrap="truncate-end"><Text bold>New session{p.waiter ? ` for ${nameOf(p.waiter)} to wait for` : ''} · directory:</Text> {p.query}<Text inverse> </Text></Text>});
		if (!p.cands.length) bottom.push({key: 'dl', el: <Text dimColor>  loading...</Text>});
		bottom.push(...menu(items.map(it => ({label: it.label})), p.sel, 8, true));
		help = 'type to filter · ↑↓ select · enter choose · esc cancel';
	} else if (p?.kind === 'dirOther') {
		bottom.push({key: 'do', el: <Text wrap="truncate-end"><Text bold>Directory:</Text> {p.text}<Text inverse> </Text></Text>});
		if (p.error) bottom.push({key: 'de', el: <Text color="red">{p.error}</Text>});
		help = `Enter confirm (empty: ${launchDir}) · esc cancel`;
	} else if (p?.kind === 'model') {
		bottom.push({key: 'mt', el: <Text wrap="truncate-end"><Text bold>Model</Text> for {p.dir}:</Text>});
		bottom.push(...menu([{label: 'default'}, {label: 'Other...'}], p.sel));
		help = '↑↓ select · enter choose · esc cancel';
	} else if (p?.kind === 'modelOther') {
		bottom.push({key: 'mo', el: <Text wrap="truncate-end"><Text bold>Model name:</Text> {p.text}<Text inverse> </Text></Text>});
		help = 'enter launch · esc back';
	} else if (p?.kind === 'launching') {
		const secs = Math.floor((Date.now() - p.startedAt) / 1000);
		bottom.push({key: 'l1', el: <Text wrap="truncate-end"><Text bold>New session</Text> in {p.dir} · model: {p.model ?? 'default'}</Text>});
		bottom.push({key: 'l2', el: <Text color="cyan">Starting... {secs}s</Text>});
		help = '';
	} else if (p?.kind === 'launchFailed') {
		bottom.push({key: 'lf', el: <Text color="red" wrap="wrap">Could not start the session:{'\n'}{p.output}</Text>});
		help = 'press any key to return';
	} else if (p?.kind === 'confirm') {
		bottom.push({key: 'cf', el: <Text color="yellow" wrap="wrap">{p.text}</Text>});
		help = p.defaultYes ? 'Y/n' : 'y/N';
	}
	if (help) bottom.push({key: 'help', el: <Text dimColor wrap="truncate-end">{help}</Text>});

	// scrolling window
	const bottomH = bottom.reduce((a, l) => a + (l.key === 'lf' || l.key === 'cf' || l.key === 'err' || l.key === 'msg' ? Math.max(1, Math.ceil(stringWidth(String(msgText ?? '')) / width)) : 1), 0);
	const avail = Math.max(1, (termRows || 24) - header.length - fixed.length - bottomH - 1);
	let visible = scroll;
	let indicator: string | null = null;
	if (scroll.length > avail) {
		const win = Math.max(1, avail - 1);
		const selStart = scroll.findIndex(l => l.row && l.sid === st.cursor);
		let start = 0;
		if (selStart >= 0) {
			let selEnd = selStart + 1;
			while (selEnd < scroll.length && !scroll[selEnd]!.row && scroll[selEnd]!.sid === st.cursor) selEnd++;
			start = selStart - Math.floor((win - (selEnd - selStart)) / 2);
			start = Math.max(0, Math.min(start, scroll.length - win));
		}
		visible = scroll.slice(start, start + win);
		const idx = st.cursor ? order.indexOf(st.cursor) + 1 : 0;
		indicator = `${idx}/${order.length}`;
	}

	return (
		<Box flexDirection="column" width={width}>
			{header.map(l => (
				<Box key={l.key}>{l.el}</Box>
			))}
			{fixed.map(l => (
				<Box key={l.key}>{l.el}</Box>
			))}
			{visible.map(l => (
				<Box key={l.key}>{l.el}</Box>
			))}
			{indicator && <Text dimColor>{indicator}</Text>}
			{bottom.map(l => (
				<Box key={l.key}>{l.el}</Box>
			))}
		</Box>
	);
}
