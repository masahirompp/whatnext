// 一覧の状態と操作。React は描くだけで、キー入力もここで処理する。
import {execFile} from 'node:child_process';
import {appendFileSync, existsSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve as resolvePath} from 'node:path';
import type {Key} from 'ink';
import {classify, dedupe, displayName, fetchAgents, type AgentRow, type Tier} from './agents.js';
import {filterCands, ghqList, labelsFor, type Cand} from './candidates.js';
import {copy} from './clipboard.js';
import {KEY_SH, SOCKET} from './env.js';
import {canWaitFor, compareRank, deriveTiers, descendants, layout, parentOf, rankKey, type Layout, type Node, type Waits} from './model.js';
import {ctx, hooks, launchSettings, type HookState} from './receiver.js';
import {bangCommands, headOf, oneLine, toolTarget} from './text.js';
import {ensureClaudeSession, listClients, listSessions, takeRequest, tmux, tmuxDetached} from './tmux.js';
import {readTranscript, type TranscriptInfo} from './transcript.js';
import {fetchUsage, type UsageItem} from './usage.js';
import {closeFor, runningInWorkbenches} from './workbench.js';
import {fetchPr, gitWhere, mainRepoOf, type Where} from './where.js';

export type Session = {
	sid: string;
	row: AgentRow;
	name: string;
	own: Tier;
	reason?: string;
	since: number | null;
	note?: string;
	bangs: string[];
	running: string[];
	where?: Where;
};

type MenuItem = {label: string; run?: () => void | Promise<void>; disabled?: boolean};

export type Mode =
	| {k: 'list'}
	| {k: 'input'; full?: boolean; prompt: string; value: string; hint?: string; error?: string; onEnter: (v: string) => void; onEsc: () => void}
	| {k: 'confirm'; text: string; defaultYes: boolean; resolve: (yes: boolean) => void}
	| {k: 'menu'; title: string; items: MenuItem[]; sel: number; note?: string}
	| {k: 'wait'; sid: string; filter: string; sel: number}
	| {k: 'dir'; filter: string; sel: number; cands: Cand[]; waitParent?: string; first?: string}
	| {k: 'model'; dir: string; sel: number; waitParent?: string}
	| {k: 'launching'; dir: string; model?: string; startedAt: number}
	| {k: 'launchFailed'; output: string};

type Attached = {id: string; prompts: number; snapshot?: string; uaTs?: number};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const run = (cmd: string, args: string[], opts: {cwd?: string; timeout?: number} = {}) =>
	new Promise<{code: number; out: string}>(resolve => {
		const child = execFile(cmd, args, {timeout: opts.timeout ?? 30000, cwd: opts.cwd, maxBuffer: 8 << 20}, (err, stdout, stderr) =>
			resolve({code: err ? ((err as {code?: number}).code ?? 1) : 0, out: (String(stdout) + String(stderr)).replace(ANSI, '').trim()}),
		);
		child.stdin?.end();
	});

export class Store {
	rows: AgentRow[] = [];
	sessions = new Map<string, Session>();
	error?: string;
	refreshing = false;
	lastRefresh = 0;
	private refreshAgain = false;
	private prev = new Map<string, {tier: Tier; since: number | null}>();
	private timer?: NodeJS.Timeout;

	holds = new Map<string, string>();
	waits: Waits = new Map();
	private pendingWaits: Array<{parent: string; id: string}> = [];
	doneNotes = new Map<string, string[]>();
	private prevDerived = new Map<string, Tier>();
	names = new Map<string, string>();
	ctxBySid = ctx;

	lastAttachedId?: string;
	attached?: Attached;
	cursor?: string;

	mode: Mode = {k: 'list'};
	message?: string;
	private messageTimer?: NodeJS.Timeout;
	usage?: UsageItem[];
	private usageStartedAt = 0;
	private usageInFlight = false;
	private deletePending?: {sid: string; at: number; stopping?: Promise<void>};
	// 止めている・削除している最中の行(STATUS の欄に出す。削除中の行は薄くし、操作を受け付けない)
	busy = new Map<string, 'stopping' | 'deleting'>();
	private menuPick?: {token: string; cmds: string[]; tty: string; pane?: string};
	private extPick?: {token: string; targets: ExternalTarget[]; tty: string};
	startDir = process.cwd();
	receiverOpen = false;

	private listeners = new Set<() => void>();
	version = 0;
	subscribe(fn: () => void) {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}
	emit() {
		this.version++;
		for (const fn of this.listeners) fn();
	}

	say(text: string | undefined, ms = 6000) {
		this.message = text;
		clearTimeout(this.messageTimer);
		if (text && ms > 0) this.messageTimer = setTimeout(() => {
			if (this.message === text) {
				this.message = undefined;
				this.emit();
			}
		}, ms);
		this.emit();
	}

	// ---- 更新 ----

	async refresh(opts: {manual?: boolean} = {}): Promise<void> {
		if (this.refreshing) {
			this.refreshAgain = true;
			return;
		}
		this.refreshing = true;
		clearTimeout(this.timer);
		this.emit();
		try {
			await this.doRefresh();
			if (opts.manual) this.say('Refreshed.', 2000);
		} finally {
			this.refreshing = false;
			this.timer = setTimeout(() => void this.refresh(), 60000);
			this.emit();
			if (this.refreshAgain) {
				this.refreshAgain = false;
				void this.refresh();
			}
		}
	}

	private async doRefresh() {
		let rows: AgentRow[];
		try {
			rows = dedupe(await fetchAgents());
		} catch (e) {
			this.error = (e as Error).message;
			this.sessions = new Map();
			return;
		}
		this.error = undefined;
		const first = this.lastRefresh === 0;
		const now = Date.now();
		this.rows = rows;
		for (const r of rows) this.names.set(r.sessionId, displayName(r));

		const visible = rows.flatMap(r => {
			const c = classify(r);
			return c ? [{r, c}] : [];
		});
		const [infos, running, wheres] = await Promise.all([
			Promise.all(visible.map(v => readTranscript(v.r.sessionId))),
			runningInWorkbenches(),
			Promise.all(visible.map(v => gitWhere(v.r.cwd, true))),
		]);

		const sessions = new Map<string, Session>();
		visible.forEach(({r, c}, i) => {
			const sid = r.sessionId;
			const hook = hooks.get(sid);
			const tr = infos[i];
			let since: number | null | undefined = sinceFrom(c.tier, hook, tr);
			if (since === undefined) {
				// 悲観的に数える: 更新の間に今の段に入った行は、前回の更新時刻から待っていたとみなす
				const p = this.prev.get(sid);
				since = p && p.tier === c.tier ? p.since : first ? null : this.lastRefresh;
			}
			const {note, response} = noteFor(c.tier, r, hook, tr);
			sessions.set(sid, {
				sid,
				row: r,
				name: displayName(r),
				own: c.tier,
				reason: c.reason,
				since,
				note,
				bangs: c.tier === 'working' ? [] : bangCommands(response),
				running: (r.id && running.get(r.id)) || [],
				where: {...wheres[i]!, pr: this.sessions.get(sid)?.where?.pr},
			});
		});
		this.prev = new Map([...sessions.values()].map(s => [s.sid, {tier: s.own, since: s.since}]));

		// 待ち先: 起動を待っていたものを結ぶ。行が消えた(削除された)関係は切る
		const present = new Set(rows.map(r => r.sessionId));
		for (const pw of [...this.pendingWaits]) {
			const child = rows.find(r => r.id === pw.id);
			if (!child) continue;
			this.pendingWaits.splice(this.pendingWaits.indexOf(pw), 1);
			if (present.has(pw.parent) && canWaitFor(this.waits, pw.parent, child.sessionId)) this.link(pw.parent, child.sessionId);
		}
		for (const [p, cs] of this.waits) {
			if (!present.has(p)) this.waits.delete(p);
			else for (const c of cs) if (!present.has(c)) cs.delete(c);
		}
		// 一覧から消えた(対象外になった)セッションの保留は解く
		for (const sid of [...this.holds.keys()]) if (!sessions.has(sid)) this.holds.delete(sid);

		this.sessions = sessions;
		this.updateDoneNotes();
		this.lastRefresh = now;
		this.fixCursor();
		void this.fetchPrs();
	}

	private async fetchPrs() {
		await Promise.all(
			[...this.sessions.values()].map(async s => {
				const w = s.where;
				if (!w?.branch) return;
				const pr = await fetchPr(s.row.cwd, w.branch);
				const cur = this.sessions.get(s.sid);
				if (!cur?.where) return;
				if (pr?.number === cur.where.pr?.number && pr?.state === cur.where.pr?.state) return;
				cur.where = {...cur.where, pr};
				this.emit();
			}),
		);
	}

	tiers(): Map<string, Tier> {
		return deriveTiers(this.sessions, this.waits);
	}

	private updateDoneNotes() {
		const tiers = this.tiers();
		for (const [sid, s] of this.sessions) {
			const now = tiers.get(sid)!;
			const before = this.prevDerived.get(sid);
			if (now === 'waiting') this.doneNotes.delete(sid);
			else if (before === 'waiting' && now === s.own) this.doneNotes.set(sid, [...(this.waits.get(sid) ?? [])]);
		}
		this.prevDerived = tiers;
	}

	layout(): Layout<Session> {
		const last = this.lastAttachedId ? this.rows.find(r => r.id === this.lastAttachedId)?.sessionId : undefined;
		return layout(this.sessions, this.tiers(), this.waits, new Set(this.holds.keys()), last);
	}

	order(l = this.layout()): Node<Session>[] {
		return [...l.last, ...l.ladder, ...l.hold];
	}

	// 一番上の組の位置を決めた行(実際に手を付ける行)
	private topPick(l: Layout<Session>, skipLast = false): string | undefined {
		const tiers = this.tiers();
		const group = (skipLast ? [] : l.last).length ? l.last : l.ladder.length ? l.ladder : l.hold;
		const root = group[0]?.root;
		let best: Node<Session> | undefined;
		for (const n of group.filter(n => n.root === root)) {
			if (n.depth > 0 && this.holds.has(n.s.sid)) continue;
			const k = rankKey(tiers.get(n.s.sid)!, n.s.since, n.s.name);
			if (!best || compareRank(k, rankKey(tiers.get(best.s.sid)!, best.s.since, best.s.name)) < 0) best = n;
		}
		return best?.s.sid ?? group[0]?.s.sid;
	}

	private fixCursor() {
		if (this.cursor && this.sessions.has(this.cursor)) return;
		this.cursor = this.topPick(this.layout());
	}

	// ---- attach ----

	async attach(s: Session) {
		const r = s.row;
		if (r.kind !== 'background' || !r.id) {
			this.say(`${s.name} is an interactive session and can't be attached from here. cwd: ${r.cwd}  pid: ${r.pid ?? '-'}`, 15000);
			return;
		}
		await this.attachId(r.id, r.cwd, s.name, s.sid);
	}

	private async attachId(id: string, cwd: string, name: string, sid?: string) {
		const ok = await ensureClaudeSession(id, cwd, name);
		const me = (await listClients()).find(c => c.session === 'list');
		if (!ok || !me) {
			this.say(`Could not open ${name}.`);
			return;
		}
		this.attached = {id, prompts: sid ? (hooks.get(sid)?.prompts ?? 0) : 0};
		if (sid) this.doneNotes.delete(sid);
		await tmux('switch-client', '-c', me.tty, '-t', `=${id}`);
		const a = this.attached;
		if (sid) {
			const [rows, tr] = await Promise.all([fetchAgents().catch(() => undefined), readTranscript(sid)]);
			const row = rows?.find(x => x.sessionId === sid);
			a.snapshot = row ? snapshot(row) : undefined;
			a.uaTs = tr?.lastUserAssistantTs;
		}
	}

	private notifyChain = Promise.resolve();
	onNotify() {
		this.notifyChain = this.notifyChain.then(() => this.handleNotify()).catch(() => undefined);
	}

	private async handleNotify() {
		const req = await takeRequest();
		if (req) await this.handleRequest(req);
		const clients = (await listClients()).filter(c => !c.session.startsWith('sh-'));
		if (clients.length === 0) return; // 端末のウィンドウを閉じた。見ていた画面は覚えておく
		if (clients.some(c => c.session === 'list')) {
			if (this.attached) {
				const a = this.attached;
				this.attached = undefined;
				await this.onReturn(a);
			}
		} else {
			const on = clients[0]!.session;
			if (this.attached?.id !== on) this.attached = {id: on, prompts: 0};
		}
	}

	private async onReturn(a: Attached) {
		this.lastAttachedId = a.id;
		const sid = this.rows.find(r => r.id === a.id)?.sessionId;
		if (sid) this.cursor = sid;
		this.mode = {k: 'list'};
		this.maybeFetchUsage(false);
		await this.refresh();
		const cur = this.rows.find(r => r.id === a.id);
		if (cur) {
			this.cursor = this.sessions.has(cur.sessionId) ? cur.sessionId : this.topPick(this.layout(), true);
			if (this.holds.has(cur.sessionId)) {
				const tr = await readTranscript(cur.sessionId);
				const worked =
					(a.snapshot !== undefined && a.snapshot !== snapshot(cur)) ||
					(hooks.get(cur.sessionId)?.prompts ?? 0) > a.prompts ||
					(tr?.lastUserAssistantTs ?? 0) > (a.uaTs ?? Number.MAX_SAFE_INTEGER);
				if (worked) this.holds.delete(cur.sessionId);
			}
		} else this.cursor = this.topPick(this.layout(), true);
		this.emit();
	}

	// ---- tmux からの頼みごと(ctrl+q y) ----

	private async handleRequest(req: string) {
		debug(`request ${req}`);
		const [kind, ...args] = req.split(' ');
		if (kind === 'menu') {
			const [sn = '', tty = '', pane = ''] = args;
			const fromWorkbench = sn.startsWith('sh-');
			const id = fromWorkbench ? sn.slice(3) : sn;
			const row = await this.rowFor(id);
			const cmds = row ? await this.freshBangs(row) : [];
			if (cmds.length === 0) {
				flash(tty, 'No ! commands in the last response.');
				return;
			}
			const token = Math.random().toString(36).slice(2, 10);
			this.menuPick = {token, cmds, tty, pane: fromWorkbench ? pane : undefined};
			const items = cmds.flatMap((c, i) => [
				` ${c.replaceAll('#', '##')}`,
				i < 9 ? String(i + 1) : '',
				`run-shell -b "sh '${KEY_SH}' '${SOCKET}' req pick ${token} ${i} >/dev/null 2>&1; true"`,
			]);
			tmuxDetached('display-menu', '-c', tty, '-T', 'Copy ! commands', ...items);
		} else if (kind === 'pick') {
			const [token, i] = args;
			const p = this.menuPick;
			if (!p || p.token !== token) return;
			const cmd = p.cmds[Number(i)];
			if (!cmd) return;
			await copy(cmd);
			if (p.pane) {
				await tmux('set-buffer', '-b', 'wnpick', '--', cmd);
				await tmux('paste-buffer', '-p', '-d', '-b', 'wnpick', '-t', p.pane);
			}
			flash(p.tty, `Copied: ${cmd}`);
		} else if (kind === 'ext') {
			// ctrl+q e: e と同じ開く先を tmux のメニューに出す
			const [sn = '', tty = ''] = args;
			const id = sn.startsWith('sh-') ? sn.slice(3) : sn;
			const row = await this.rowFor(id);
			if (!row) return;
			// 一覧に出ていないセッション(指示を送る前の新しいセッションなど)にも attach できるので、そのときは行から組み立てる
			const s = this.sessions.get(row.sessionId);
			const name = s?.name ?? displayName(row);
			let where = s?.where;
			if (!where) {
				where = await gitWhere(row.cwd);
				if (where.branch) where = {...where, pr: await fetchPr(row.cwd, where.branch)};
			}
			const targets = externalTargets(where, row.cwd);
			const token = Math.random().toString(36).slice(2, 10);
			this.extPick = {token, targets, tty};
			const items = targets.flatMap((t, i) => [
				` ${t.label.replaceAll('#', '##')}`,
				i < 9 ? String(i + 1) : '',
				`run-shell -b "sh '${KEY_SH}' '${SOCKET}' req extpick ${token} ${i} >/dev/null 2>&1; true"`,
			]);
			// 先頭が - の項目は選べない行として出る
			if (!where.pr) items.push('- No pull request for this session.', '', '');
			tmuxDetached('display-menu', '-c', tty, '-T', `Show ${name.replaceAll('#', '##')} in:`, ...items);
		} else if (kind === 'extpick') {
			const [token, i] = args;
			const p = this.extPick;
			if (!p || p.token !== token) return;
			const t = p.targets[Number(i)];
			if (!t) return;
			const r = await run('open', [t.target]);
			flash(p.tty, r.code === 0 ? `Opened ${t.what}.` : `open failed: ${r.out}`);
		}
	}

	// attach した直後に起動したセッションは、まだ読み直していない --json にないので、なければ読み直す
	private async rowFor(id: string): Promise<AgentRow | undefined> {
		const hit = this.rows.find(r => r.id === id);
		if (hit) return hit;
		try {
			return dedupe(await fetchAgents()).find(r => r.id === id);
		} catch {
			return undefined;
		}
	}

	private async freshBangs(row: AgentRow): Promise<string[]> {
		const c = classify(row);
		const tr = await readTranscript(row.sessionId);
		const {response} = noteFor(c?.tier ?? 'review', row, hooks.get(row.sessionId), tr);
		return bangCommands(response);
	}

	// ---- Usage ----

	maybeFetchUsage(force: boolean) {
		if (this.usageInFlight) return;
		if (!force && Date.now() - this.usageStartedAt < 60000) return;
		this.usageStartedAt = Date.now();
		this.usageInFlight = true;
		void fetchUsage().then(items => {
			this.usageInFlight = false;
			if (items) this.usage = items;
			this.emit();
		});
	}

	// ---- 起動時の後始末(前の whatnext が異常終了していたとき) ----

	async recoverLeftovers() {
		const leftovers = (await listSessions()).filter(s => s !== 'list');
		if (leftovers.length === 0) return;
		const running = await runningInWorkbenches();
		for (const s of leftovers) {
			if (!s.startsWith('sh-')) await tmux('kill-session', '-t', `=${s}`);
			else if (!running.has(s.slice(3))) await tmux('kill-session', '-t', `=${s}`);
		}
		if (running.size === 0) return;
		const n = [...running.values()].reduce((a, c) => a + c.length, 0);
		const keep = await this.confirm(
			`${n} command${n > 1 ? 's are' : ' is'} still running from a previous whatnext: ${this.describeRunning(running)}. Keep ${n > 1 ? 'them' : 'it'}? [Y/n]`,
			true,
		);
		if (!keep) for (const id of running.keys()) await tmux('kill-session', '-t', `=sh-${id}`);
		this.say(keep ? 'Kept the running commands.' : 'Stopped the running commands.');
	}

	private describeRunning(running: Map<string, string[]>): string {
		return [...running].map(([id, cmds]) => `${this.nameOfId(id)}: ${cmds.join(', ')}`).join(', ');
	}

	private nameOfId(id: string): string {
		const r = this.rows.find(x => x.id === id);
		return r ? displayName(r) : id;
	}

	// 異常終了の合図(SIGTERM など)で走らせる後始末: 残した attach と何も動いていない作業台を畳む
	async cleanupOnSignal() {
		const running = await runningInWorkbenches();
		for (const s of await listSessions()) {
			if (s === 'list') continue;
			if (s.startsWith('sh-') && running.has(s.slice(3))) continue;
			await tmux('kill-session', '-t', `=${s}`);
		}
	}

	// ---- 確認 ----

	confirm(text: string, defaultYes = false): Promise<boolean> {
		return new Promise(resolve => {
			const prev = this.mode;
			this.mode = {
				k: 'confirm',
				text,
				defaultYes,
				resolve: yes => {
					this.mode = prev.k === 'confirm' ? {k: 'list'} : prev;
					this.emit();
					resolve(yes);
				},
			};
			this.emit();
		});
	}

	// ---- 終了 ----

	async quit() {
		const running = await runningInWorkbenches();
		if (running.size) {
			const n = [...running.values()].reduce((a, c) => a + c.length, 0);
			const yes = await this.confirm(`Quit and stop ${n} running command${n > 1 ? 's' : ''}? ${this.describeRunning(running)} [y/N]`);
			if (!yes) return;
		}
		await tmux('kill-server');
		process.exit(0);
	}

	// ---- 保留 ----

	private hold(s: Session) {
		const order = this.order().map(n => n.s.sid);
		const idx = order.indexOf(s.sid);
		this.mode = {
			k: 'input',
			prompt: `Put ${s.name} on hold. Reason (optional):`,
			value: '',
			onEsc: () => {
				this.mode = {k: 'list'};
				this.emit();
			},
			onEnter: reason => {
				this.mode = {k: 'list'};
				const isRoot = !parentOf(this.waits, s.sid) || !this.sessions.has(parentOf(this.waits, s.sid)!);
				const moved = new Set([s.sid, ...(isRoot ? descendants(this.waits, s.sid) : [])]);
				this.holds.set(s.sid, reason.trim());
				let next = order.slice(idx + 1).find(x => !moved.has(x));
				if (!next) next = order.slice(0, idx).reverse().find(x => !moved.has(x));
				this.cursor = next ?? s.sid;
				this.say(`Put ${s.name} on hold. It comes back when you attach and work on it, or press h on it.`, 10000);
			},
		};
		this.emit();
	}

	private unhold(s: Session) {
		this.holds.delete(s.sid);
		this.cursor = s.sid;
		this.say(`${s.name} is back in the list.`);
	}

	// ---- 待ち先 ----

	link(parent: string, child: string) {
		if (!this.waits.has(parent)) this.waits.set(parent, new Set());
		this.waits.get(parent)!.add(child);
		this.doneNotes.delete(parent);
		this.prevDerived = this.tiers();
	}

	unlink(parent: string, child: string) {
		const before = this.tiers().get(parent);
		this.waits.get(parent)?.delete(child);
		if (this.waits.get(parent)?.size === 0) this.waits.delete(parent);
		const after = this.tiers();
		if (before === 'waiting' && after.get(parent) !== 'waiting') this.doneNotes.set(parent, [...(this.waits.get(parent) ?? [])]);
		this.prevDerived = after;
	}

	waitItems(m: Extract<Mode, {k: 'wait'}>): Array<{sid?: string; label: string; linked?: boolean; s?: Session}> {
		const children = this.waits.get(m.sid) ?? new Set();
		const cands = this.order()
			.map(n => n.s)
			.filter(s => canWaitFor(this.waits, m.sid, s.sid))
			.map(s => ({sid: s.sid, label: s.name, path: `${s.where?.repo ?? ''} ${s.row.cwd}`, linked: children.has(s.sid), s}));
		return [{label: 'New session'}, ...filterCands(cands, m.filter)];
	}

	// ---- 新しいセッション ----

	private async openDir(waitParent?: string) {
		const first = waitParent ? await mainRepoOf(this.sessions.get(waitParent)?.row.cwd ?? this.startDir) : undefined;
		const base = [first, this.startDir, ...(await Promise.all(this.rows.map(r => mainRepoOf(r.cwd))))].filter((p): p is string => !!p);
		const mk = (paths: string[]) => labelsFor([...new Set(paths)]);
		this.mode = {k: 'dir', filter: '', sel: 0, cands: mk(base), waitParent, first};
		this.emit();
		const ghq = await ghqList();
		if (this.mode.k === 'dir') {
			this.mode = {...this.mode, cands: mk([...base, ...ghq])};
			this.emit();
		}
	}

	dirItems(m: Extract<Mode, {k: 'dir'}>): Array<{label: string; path?: string}> {
		return [...filterCands(m.cands, m.filter), {label: 'Other...'}];
	}

	private async launch(dir: string, model: string | undefined, waitParent?: string) {
		const startedAt = Date.now();
		this.mode = {k: 'launching', dir, model, startedAt};
		this.emit();
		const tick = setInterval(() => this.emit(), 1000);
		const args = ['--bg'];
		if (model) args.push('--model', model);
		const settings = launchSettings();
		if (settings) args.push('--settings', settings);
		const r = await run('claude', args, {cwd: dir, timeout: 120000});
		clearInterval(tick);
		const m = /backgrounded\s*·\s*([0-9a-f]{8})/.exec(r.out);
		if (!m) {
			this.mode = {k: 'launchFailed', output: r.out || `claude --bg exited with code ${r.code}`};
			this.emit();
			return;
		}
		const id = m[1]!;
		if (waitParent) this.pendingWaits.push({parent: waitParent, id});
		this.mode = {k: 'list'};
		this.emit();
		await this.attachId(id, dir, id);
	}

	// ---- 停止と削除 ----

	private async ctrlX(s: Session) {
		const id = s.row.id;
		if (s.row.kind !== 'background' || !id) return;
		const p = this.deletePending;
		if (p && p.sid === s.sid && (Date.now() - p.at <= 2000 || p.stopping)) {
			this.deletePending = undefined;
			// 止め終わるのを待つ間も、2回目を受けた時点から削除中として出す
			this.busy.set(s.sid, 'deleting');
			this.say(undefined);
			this.emit();
			await p.stopping;
			await this.deleteFlow(s);
			return;
		}
		const pending: {sid: string; at: number; stopping?: Promise<void>} = {sid: s.sid, at: Date.now()};
		this.deletePending = pending;
		this.say(`Stopping ${s.name}...`, 0);
		this.busy.set(s.sid, 'stopping');
		this.emit();
		pending.stopping = (async () => {
			const r = await run('claude', ['stop', id]);
			if (this.busy.get(s.sid) === 'stopping') this.busy.delete(s.sid);
			if (r.code === 0) {
				await tmux('kill-session', '-t', `=${id}`);
				if (this.deletePending === pending) this.say(`Stopped ${s.name}. Press Ctrl+X again within 2s to delete.`, 2500);
			} else if (this.deletePending === pending) {
				this.say(`Stop failed: ${oneLine(r.out)} (Ctrl+X again to delete)`, 8000);
			}
			pending.at = Date.now();
			pending.stopping = undefined;
			setTimeout(() => {
				if (this.deletePending === pending) {
					this.deletePending = undefined;
					void this.refresh();
				}
			}, 2100);
		})();
	}

	private async deleteFlow(s: Session) {
		let targets = [s.sid];
		this.busy.set(s.sid, 'deleting');
		// 「もう一度 Ctrl+X で削除」の案内は、削除を始めたら役目を終える
		this.say(undefined);
		this.emit();
		const desc = descendants(this.waits, s.sid).filter(x => this.rows.some(r => r.sessionId === x));
		if (desc.length) {
			const names = desc.map(x => this.names.get(x) ?? x).join(', ');
			const yes = await this.confirm(`Also delete ${desc.length} session${desc.length > 1 ? 's' : ''} this one was waiting for? (${names}) [y/N]`);
			if (yes) targets = [s.sid, ...desc];
		}
		for (const sid of targets) this.busy.set(sid, 'deleting');
		this.emit();
		for (const sid of targets) {
			// 削除しなかった行は、すぐに元の表示に戻す。削除した行は、一覧から消えるまで削除中のまま出す
			if (!(await this.deleteOne(sid, sid !== s.sid))) {
				this.busy.delete(sid);
				this.emit();
			}
		}
		await this.refresh();
		for (const sid of targets) this.busy.delete(sid);
		this.emit();
	}

	private async deleteOne(sid: string, cascade: boolean): Promise<boolean> {
		const row = this.rows.find(r => r.sessionId === sid);
		const id = row?.id;
		if (!row || !id) return false;
		const name = displayName(row);
		const running = (await runningInWorkbenches()).get(id);
		if (running?.length) {
			const yes = await this.confirm(`Delete ${name} and stop the commands running in its workbench? ${running.join(', ')} [y/N]`);
			if (!yes) {
				this.say(`Kept ${name}.`);
				return false;
			}
		}
		if (cascade && row.pid !== undefined) await run('claude', ['stop', id]);
		let extra: string[] = [];
		for (let attempt = 0; attempt < 40; attempt++) {
			const r = await run('claude', ['rm', id, ...extra]);
			if (r.code === 0) {
				await closeFor(id);
				this.holds.delete(sid);
				this.waits.delete(sid);
				for (const cs of this.waits.values()) cs.delete(sid);
				this.say(`Deleted ${name}.`);
				return true;
			}
			const discard = /--discard-unpushed\s+(\S+)/.exec(r.out);
			if (discard && extra.length === 0) {
				const n = Number(/(\d+) unpushed commit/.exec(r.out)?.[1] ?? 1);
				const yes = await this.confirm(`Discard ${n} unpushed commit${n > 1 ? 's' : ''} and delete session ${id}? [y/N]`);
				if (!yes) {
					this.say(`Kept ${name}.`);
					return false;
				}
				extra = ['--discard-unpushed', discard[1]!.replace(/[.,'"”]+$/, '')];
				continue;
			}
			// stop の直後はプロセスが終わるまでロックで断られる。未コミットの変更の断りは待たない
			if (/^kept\b.*still at/m.test(r.out) && !/uncommitted changes/i.test(r.out)) {
				await new Promise(res => setTimeout(res, 1000));
				continue;
			}
			this.say(r.out || `claude rm exited with code ${r.code}`, 15000);
			return false;
		}
		this.say(`Could not delete ${name}: the session is still stopping.`);
		return false;
	}

	// ---- 外のアプリ ----

	private externalMenu(s: Session) {
		const items: MenuItem[] = externalTargets(s.where, s.row.cwd).map(t => ({
			label: t.label,
			run: async () => {
				const r = await run('open', [t.target]);
				this.say(r.code === 0 ? `Opened ${t.what}.` : `open failed: ${r.out}`);
			},
		}));
		this.mode = {k: 'menu', title: `Show ${s.name} in:`, items, sel: 0, note: s.where?.pr ? undefined : 'No pull request for this session.'};
		this.emit();
	}

	private copyMenu(s: Session) {
		if (s.bangs.length === 0) return;
		const doCopy = async (c: string) => {
			await copy(c);
			this.say(`Copied: ${c}`);
		};
		if (s.bangs.length === 1) {
			void doCopy(s.bangs[0]!);
			return;
		}
		this.mode = {k: 'menu', title: `Copy ! commands from ${s.name}:`, items: s.bangs.map(c => ({label: c, run: () => doCopy(c)})), sel: 0};
		this.emit();
	}

	// ---- キー入力 ----

	selected(): Session | undefined {
		return this.cursor ? this.sessions.get(this.cursor) : undefined;
	}

	key(input: string, key: Key) {
		const m = this.mode;
		debug(`key ${JSON.stringify(input)} ctrl=${key.ctrl} mode=${m.k} pending=${this.deletePending?.sid.slice(0, 8) ?? '-'} cursor=${this.cursor?.slice(0, 8)}`);
		switch (m.k) {
			case 'list':
				return this.listKey(input, key);
			case 'input':
				if (key.escape) return m.onEsc();
				if (key.return) return m.onEnter(m.value);
				if (key.backspace || key.delete) m.value = [...m.value].slice(0, -1).join('');
				else if (input && !key.ctrl && !key.meta) m.value += input.replace(/[\r\n]/g, '');
				m.error = undefined;
				return this.emit();
			case 'confirm': {
				if (input === 'y' || input === 'Y') return m.resolve(true);
				if (input === 'n' || input === 'N' || key.escape) return m.resolve(false);
				if (key.return) return m.resolve(m.defaultYes);
				return;
			}
			case 'menu':
				return this.menuKey(m, input, key);
			case 'wait':
				return this.waitKey(m, input, key);
			case 'dir':
				return this.dirKey(m, input, key);
			case 'model':
				return this.modelKey(m, input, key);
			case 'launching':
				return;
			case 'launchFailed':
				this.mode = {k: 'list'};
				this.emit();
				return void this.refresh();
		}
	}

	private move(delta: number) {
		const order = this.order();
		const i = order.findIndex(n => n.s.sid === this.cursor);
		const j = Math.max(0, Math.min(order.length - 1, (i < 0 ? 0 : i) + delta));
		this.cursor = order[j]?.s.sid;
		this.emit();
	}

	private listKey(input: string, key: Key) {
		const s = this.selected();
		const isCtrlX = key.ctrl && input === 'x';
		if (this.deletePending && !isCtrlX) {
			this.deletePending = undefined;
			if (key.escape) return this.say('Delete canceled.', 2000);
		}
		if (key.upArrow) return this.move(-1);
		if (key.downArrow) return this.move(1);
		if (key.pageUp) return this.move(-10);
		if (key.pageDown) return this.move(10);
		// 削除している最中の行では、行に対する操作を受け付けない(カーソルの移動、更新、終了などは効く)
		const target = s && this.busy.get(s.sid) !== 'deleting' ? s : undefined;
		if (key.return) return target && void this.attach(target);
		if (isCtrlX) return target && void this.ctrlX(target);
		if (key.ctrl || key.meta) return;
		switch (input) {
			case 'r':
				this.maybeFetchUsage(false);
				return void this.refresh({manual: true});
			case 'q':
				return void this.quit();
			case 'n':
				return void this.openDir();
			case 'h':
				if (!target) return;
				return this.holds.has(target.sid) ? this.unhold(target) : this.hold(target);
			case 'w':
				if (!target) return;
				this.mode = {k: 'wait', sid: target.sid, filter: '', sel: 0};
				return this.emit();
			case 'e':
				return target && this.externalMenu(target);
			case 'c':
				return s && this.copyMenu(s);
		}
	}

	private menuKey(m: Extract<Mode, {k: 'menu'}>, input: string, key: Key) {
		if (key.escape) {
			this.mode = {k: 'list'};
			return this.emit();
		}
		if (key.upArrow) m.sel = Math.max(0, m.sel - 1);
		else if (key.downArrow) m.sel = Math.min(m.items.length - 1, m.sel + 1);
		else if (key.return || /^[1-9]$/.test(input)) {
			const item = key.return ? m.items[m.sel] : m.items[Number(input) - 1];
			if (!item) return;
			this.mode = {k: 'list'};
			this.emit();
			void item.run?.();
			return;
		}
		this.emit();
	}

	private waitKey(m: Extract<Mode, {k: 'wait'}>, input: string, key: Key) {
		if (key.escape) {
			this.mode = {k: 'list'};
			return this.emit();
		}
		const items = this.waitItems(m);
		if (key.upArrow) m.sel = Math.max(0, m.sel - 1);
		else if (key.downArrow) m.sel = Math.min(items.length - 1, m.sel + 1);
		else if (key.return) {
			const item = items[m.sel];
			if (!item) return;
			this.mode = {k: 'list'};
			if (!item.sid) return void this.openDir(m.sid);
			const pn = this.sessions.get(m.sid)?.name;
			if (item.linked) {
				this.unlink(m.sid, item.sid);
				this.say(`${pn} no longer waits for ${item.label}.`);
			} else {
				this.link(m.sid, item.sid);
				this.say(`${pn} now waits for ${item.label}.`);
			}
			return;
		} else if (key.backspace || key.delete) {
			m.filter = [...m.filter].slice(0, -1).join('');
			m.sel = m.filter && this.waitItems(m).length > 1 ? 1 : 0;
		} else if (input && !key.ctrl && !key.meta) {
			m.filter += input.replace(/[\r\n]/g, '');
			m.sel = this.waitItems(m).length > 1 ? 1 : 0;
		}
		this.emit();
	}

	private dirKey(m: Extract<Mode, {k: 'dir'}>, input: string, key: Key) {
		if (key.escape) {
			this.mode = {k: 'list'};
			return this.emit();
		}
		const items = this.dirItems(m);
		if (key.upArrow) m.sel = Math.max(0, m.sel - 1);
		else if (key.downArrow) m.sel = Math.min(items.length - 1, m.sel + 1);
		else if (key.return) {
			const item = items[m.sel];
			if (!item) return;
			if (item.path) {
				this.mode = {k: 'model', dir: item.path, sel: 0, waitParent: m.waitParent};
				return this.emit();
			}
			return this.otherDir(m);
		} else if (key.backspace || key.delete) {
			m.filter = [...m.filter].slice(0, -1).join('');
			m.sel = 0;
		} else if (input && !key.ctrl && !key.meta) {
			m.filter += input.replace(/[\r\n]/g, '');
			m.sel = 0;
		}
		this.emit();
	}

	private otherDir(back: Extract<Mode, {k: 'dir'}>) {
		const mode: Extract<Mode, {k: 'input'}> = {
			k: 'input',
			full: true,
			prompt: 'Directory:',
			value: back.filter,
			hint: `Enter confirm (empty: ${this.startDir.replace(homedir(), '~')})  Esc back`,
			onEsc: () => {
				this.mode = back;
				this.emit();
			},
			onEnter: v => {
				const raw = v.trim();
				const dir = raw ? resolvePath(this.startDir, raw.replace(/^~(?=$|\/)/, homedir())) : this.startDir;
				let ok = false;
				try {
					ok = existsSync(dir) && statSync(dir).isDirectory();
				} catch {
					ok = false;
				}
				if (!ok) {
					mode.error = `Not a directory: ${dir}`;
					return this.emit();
				}
				this.mode = {k: 'model', dir, sel: 0, waitParent: back.waitParent};
				this.emit();
			},
		};
		this.mode = mode;
		this.emit();
	}

	private modelKey(m: Extract<Mode, {k: 'model'}>, _input: string, key: Key) {
		if (key.escape) return void this.openDir(m.waitParent);
		if (key.upArrow) m.sel = 0;
		else if (key.downArrow) m.sel = 1;
		else if (key.return) {
			if (m.sel === 0) return void this.launch(m.dir, undefined, m.waitParent);
			const mode: Extract<Mode, {k: 'input'}> = {
				k: 'input',
				full: true,
				prompt: 'Model:',
				value: '',
				hint: 'Enter launch  Esc back',
				onEsc: () => {
					this.mode = m;
					this.emit();
				},
				onEnter: v => {
					if (!v.trim()) return;
					void this.launch(m.dir, v.trim(), m.waitParent);
				},
			};
			this.mode = mode;
		}
		this.emit();
	}
}

// attach した画面に短い知らせを出す。status off のサーバでは、claude の画面が描き直すと
// display-message の行が約0.2秒で上書きされるので、2秒の間出し直す
type ExternalTarget = {label: string; target: string; what: string};

// e と ctrl+q e の開く先(よく使う順)
function externalTargets(w: Where | undefined, cwd: string): ExternalTarget[] {
	const out: ExternalTarget[] = [];
	if (w?.pr) out.push({label: `Pull request #${w.pr.number} on GitHub`, target: w.pr.url, what: `pull request #${w.pr.number} on GitHub`});
	const dir = w?.checkoutRoot ?? cwd;
	const short = dir.replace(homedir(), '~');
	out.push({label: `VS Code: ${short}`, target: `vscode://file${dir}/`, what: `${short} in VS Code`});
	const gh = w?.pr && /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(w.pr.url);
	if (gh) out.push({label: `Pull request #${gh[3]} on vscode.dev`, target: `https://vscode.dev/github/${gh[1]}/${gh[2]}/pull/${gh[3]}`, what: `pull request #${gh[3]} on vscode.dev`});
	return out;
}

function flash(tty: string, text: string, ms = 2000) {
	const until = Date.now() + ms;
	const once = async () => {
		if (Date.now() >= until) return;
		await tmux('display-message', '-c', tty, '-d', '300', text.replaceAll('#', '##'));
		setTimeout(() => void once(), 150);
	};
	void once();
}

// 開発用。WHATNEXT_DEBUG にファイルのパスを渡したときだけ書く(利用者向けではない)
export function debug(line: string) {
	const path = process.env.WHATNEXT_DEBUG;
	if (path) appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
}

const snapshot = (r: AgentRow) => `${r.state ?? ''}|${r.status ?? ''}|${r.waitingFor ?? ''}`;

const maxTs = (...ts: Array<number | undefined>) => Math.max(0, ...ts.map(t => t ?? 0));

// 待機時間の起点(フック → 会話記録)。どちらからも取れなければ undefined(観測で推定する)
function sinceFrom(tier: Tier, hook: HookState | undefined, tr: TranscriptInfo | undefined): number | undefined {
	const hp = hook?.prompt?.ts ?? 0;
	if (tier === 'working') {
		const t = maxTs(hp, tr?.instruction?.ts);
		return t || undefined;
	}
	const stop = maxTs(hook?.stop?.ts, hook?.stopFailure?.ts, hook?.permission?.ts, hook?.ask?.ts);
	if (stop && stop >= hp) return stop;
	if (tr && (tr.instruction?.ts ?? 0) >= hp - 2000) {
		if (tier === 'permission' && tr.pendingTool) return tr.pendingTool.ts;
		if (tr.lastTs) return tr.lastTs;
	}
	return undefined;
}

// 行の一言と、最後の応答(`!` のコマンドを拾う本文)
function noteFor(tier: Tier, row: AgentRow, hook: HookState | undefined, tr: TranscriptInfo | undefined): {note?: string; response?: string} {
	const hp = hook?.prompt?.ts ?? 0;
	// 会話記録がフックより古い指示のものなら、前のターンの値なので使わない
	const trFresh = tr && (tr.instruction?.ts ?? 0) >= hp - 2000 ? tr : undefined;
	const fresh = (ts: number | undefined) => ts !== undefined && ts >= hp;
	const response = fresh(hook?.stop?.ts) ? hook!.stop!.text : trFresh?.lastText?.text;
	const head = () => headOf(response);

	if (tier === 'working') {
		const text = hp && hp >= (tr?.instruction?.ts ?? 0) ? hook!.prompt!.text : tr?.instruction?.text;
		return {note: text ? `→ ${oneLine(text)}` : undefined};
	}
	if (tier === 'permission') {
		if (fresh(hook?.permission?.ts)) return {note: toolTarget(hook!.permission!.tool, hook!.permission!.input), response};
		if (trFresh?.pendingTool) return {note: toolTarget(trFresh.pendingTool.name, trFresh.pendingTool.input), response};
		return {note: head(), response};
	}
	if (tier === 'question') {
		if (fresh(hook?.ask?.ts) && !fresh(hook?.stop?.ts)) return {note: oneLine(hook!.ask!.question), response};
		if (trFresh?.ask) return {note: oneLine(trFresh.ask.question), response};
		if (row.state === 'working' && row.status === 'idle') {
			if (fresh(hook?.permission?.ts)) return {note: `Declined: ${toolTarget(hook!.permission!.tool, hook!.permission!.input)}`, response};
			if (trFresh?.declined) return {note: `Declined: ${toolTarget(trFresh.declined.name, trFresh.declined.input)}`, response};
		}
		return {note: head(), response};
	}
	if (tier === 'failed') {
		const f = fresh(hook?.stopFailure?.ts) ? hook!.stopFailure : undefined;
		const text = f?.text || trFresh?.apiError?.text || f?.error;
		return {note: text ? oneLine(text) : head(), response};
	}
	return {note: head(), response};
}
