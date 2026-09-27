// Pure logic: classify `claude agents --json` rows into tiers, derive waiting,
// build the grouped / nested view. No I/O here.

export type RawRow = {
	kind: string;
	sessionId: string;
	id?: string;
	cwd: string;
	name?: string;
	startedAt?: number;
	pid?: number;
	state?: string;
	status?: string;
	waitingFor?: string;
};

export type Tier =
	| 'Permission'
	| 'Question'
	| 'Sandbox'
	| 'Failed'
	| 'Review'
	| 'Working'
	| 'Waiting';

export const TIER_ORDER: Tier[] = [
	'Permission',
	'Question',
	'Sandbox',
	'Failed',
	'Review',
	'Working',
	'Waiting',
];

export type Session = RawRow & {
	displayName: string;
	tier: Tier | null; // own tier; null = excluded
	reason?: string;
};

export function dedupe(rows: RawRow[]): RawRow[] {
	const bySid = new Map<string, RawRow>();
	for (const r of rows) {
		const prev = bySid.get(r.sessionId);
		if (!prev) {
			bySid.set(r.sessionId, r);
			continue;
		}
		const score = (x: RawRow) =>
			(x.pid != null ? 2 : 0) + (x.kind === 'background' ? 1 : 0);
		if (score(r) > score(prev)) bySid.set(r.sessionId, r);
	}
	return [...bySid.values()];
}

export function classify(r: RawRow): {tier: Tier | null; reason?: string} {
	const w = r.waitingFor;
	if (w) {
		if (w === 'permission prompt') return {tier: 'Permission'};
		if (w === 'input needed') return {tier: 'Question'};
		if (w === 'sandbox request') return {tier: 'Sandbox'};
		return {tier: 'Question', reason: w};
	}
	if (r.kind === 'interactive') {
		if (r.status === 'idle') return {tier: null};
		if (r.status === 'busy') return {tier: 'Working'};
		return {tier: 'Question', reason: r.status ?? 'unknown'};
	}
	switch (r.state) {
		case 'stopped':
			return {tier: null};
		case 'failed':
			return {tier: 'Failed'};
		case 'done':
			return {tier: 'Review'};
		case 'blocked':
			if (r.pid == null) return {tier: 'Failed', reason: 'no process'};
			return {tier: 'Question', reason: 'blocked'};
		case 'working':
			if (r.status === 'idle') return {tier: 'Question'};
			return {tier: 'Working'};
	}
	if (r.status === 'busy') return {tier: 'Working'};
	return {tier: 'Question', reason: r.state ?? r.status ?? 'unknown'};
}

export function toSessions(rows: RawRow[]): Session[] {
	return dedupe(rows).map(r => {
		const c = classify(r);
		return {
			...r,
			displayName: r.name ?? r.id ?? r.sessionId.slice(0, 8),
			tier: c.tier,
			reason: c.reason,
		};
	});
}

// --- waiting relations -------------------------------------------------

/** waits: waiter sessionId -> set of target sessionIds */
export type Waits = Map<string, Set<string>>;

export function parentOf(waits: Waits): Map<string, string> {
	const m = new Map<string, string>();
	for (const [p, cs] of waits) for (const c of cs) m.set(c, p);
	return m;
}

/** Tier after applying the waiting rule. */
export function deriveTiers(
	sessions: Session[],
	waits: Waits,
): Map<string, Tier | null> {
	const bySid = new Map(sessions.map(s => [s.sessionId, s]));
	const memo = new Map<string, Tier | null>();
	const visiting = new Set<string>();
	const derive = (sid: string): Tier | null => {
		if (memo.has(sid)) return memo.get(sid)!;
		const s = bySid.get(sid);
		if (!s || s.tier === null) {
			memo.set(sid, null);
			return null;
		}
		if (visiting.has(sid)) return s.tier;
		visiting.add(sid);
		let t: Tier = s.tier;
		if (t === 'Review') {
			const targets = waits.get(sid);
			if (targets && [...targets].some(c => !isDone(derive(c)))) t = 'Waiting';
		}
		visiting.delete(sid);
		memo.set(sid, t);
		return t;
	};
	for (const s of sessions) derive(s.sessionId);
	return memo;
}

export function isDone(t: Tier | null): boolean {
	return t === null || t === 'Review';
}

/** Would linking waiter -> target create a cycle or break the tree? */
export function canLink(waits: Waits, waiter: string, target: string): boolean {
	if (waiter === target) return false;
	const parents = parentOf(waits);
	const p = parents.get(target);
	if (p && p !== waiter) return false; // someone else already waits for it
	// target must not be an ancestor of waiter
	let cur: string | undefined = waiter;
	while (cur) {
		if (cur === target) return false;
		cur = parents.get(cur);
	}
	return true;
}

export function descendants(waits: Waits, sid: string): string[] {
	const out: string[] = [];
	const walk = (x: string) => {
		for (const c of waits.get(x) ?? []) {
			out.push(c);
			walk(c);
		}
	};
	walk(sid);
	return out;
}

// --- ordering ----------------------------------------------------------

export type Timing = {since: number | null}; // null = unknown

export type RankInput = {
	tier: Tier;
	since: number | null;
	name: string;
};

export function compareRank(a: RankInput, b: RankInput): number {
	const ta = TIER_ORDER.indexOf(a.tier);
	const tb = TIER_ORDER.indexOf(b.tier);
	if (ta !== tb) return ta - tb;
	if (a.since === null && b.since !== null) return -1;
	if (b.since === null && a.since !== null) return 1;
	if (a.since !== null && b.since !== null && a.since !== b.since)
		return a.since - b.since;
	return a.name.localeCompare(b.name);
}

// --- view --------------------------------------------------------------

export type Node = {
	sid: string;
	depth: number;
	/** tree-drawing prefix for the row itself, e.g. "│ ├ " */
	prefix: string;
	/** prefix for annotation lines below the row */
	notePrefix: string;
	heldInTree: boolean;
};

export type View = {
	last: Node[] | null;
	ladder: Node[];
	hold: Node[];
	/** sid that decided the position of the top-most group (first actionable) */
	topPick: string | null;
};

export type ViewInput = {
	sessions: Session[];
	tiers: Map<string, Tier | null>;
	since: Map<string, number | null>;
	waits: Waits;
	holds: Map<string, string>; // sid -> reason
	lastAttached: string | null;
};

export function buildView(inp: ViewInput): View {
	const shown = inp.sessions.filter(s => inp.tiers.get(s.sessionId) != null);
	const shownSet = new Set(shown.map(s => s.sessionId));
	const bySid = new Map(shown.map(s => [s.sessionId, s]));
	const parents = parentOf(inp.waits);
	const rank = (sid: string): RankInput => ({
		tier: inp.tiers.get(sid)!,
		since: inp.since.get(sid) ?? null,
		name: bySid.get(sid)!.displayName,
	});
	const children = (sid: string) =>
		[...(inp.waits.get(sid) ?? [])]
			.filter(c => shownSet.has(c))
			.sort((a, b) => compareRank(rank(a), rank(b)));
	const roots = shown
		.map(s => s.sessionId)
		.filter(sid => {
			const p = parents.get(sid);
			return !p || !shownSet.has(p);
		});

	const treeMembers = (root: string): string[] => {
		const out = [root];
		for (const c of children(root)) out.push(...treeMembers(c));
		return out;
	};
	// best row of a group decides its position; held non-root rows don't count
	const best = (root: string): string => {
		const members = treeMembers(root).filter(
			sid => sid === root || !inp.holds.has(sid),
		);
		return members.sort((a, b) => compareRank(rank(a), rank(b)))[0]!;
	};

	const flatten = (root: string): Node[] => {
		const out: Node[] = [];
		const walk = (sid: string, depth: number, cont: string, isLast: boolean) => {
			const kids = children(sid);
			const own = depth === 0 ? '' : cont + (isLast ? '└ ' : '├ ');
			const childCont = depth === 0 ? '' : cont + (isLast ? '  ' : '│ ');
			out.push({
				sid,
				depth,
				prefix: own,
				notePrefix: childCont + (kids.length ? '│ ' : '  '),
				heldInTree: depth > 0 && inp.holds.has(sid),
			});
			kids.forEach((k, i) => walk(k, depth + 1, childCont, i === kids.length - 1));
		};
		walk(root, 0, '', true);
		return out;
	};

	let lastRoot: string | null = null;
	if (inp.lastAttached && shownSet.has(inp.lastAttached)) {
		let r = inp.lastAttached;
		while (parents.get(r) && shownSet.has(parents.get(r)!)) r = parents.get(r)!;
		if (!inp.holds.has(r)) lastRoot = r;
	}

	const ladderRoots = roots.filter(r => r !== lastRoot && !inp.holds.has(r));
	const holdRoots = roots.filter(r => r !== lastRoot && inp.holds.has(r));
	const byBest = (a: string, b: string) => compareRank(rank(best(a)), rank(best(b)));
	ladderRoots.sort(byBest);
	holdRoots.sort(byBest);

	const topRoot = ladderRoots[0] ?? null;
	return {
		last: lastRoot ? flatten(lastRoot) : null,
		ladder: ladderRoots.flatMap(flatten),
		hold: holdRoots.flatMap(flatten),
		topPick: topRoot ? best(topRoot) : holdRoots[0] ? best(holdRoots[0]) : null,
	};
}

// --- waiting time tracking --------------------------------------------

export type Track = {tier: Tier; since: number | null};

/**
 * Pessimistic observation: a row that entered its tier since the last refresh
 * is considered waiting since the previous refresh time. Rows seen on the very
 * first refresh are unknown.
 */
export function updateTracks(
	prev: Map<string, Track>,
	tiers: Map<string, Tier | null>,
	prevRefreshAt: number | null,
): Map<string, Track> {
	const next = new Map<string, Track>();
	for (const [sid, t] of tiers) {
		if (t === null) continue;
		const p = prev.get(sid);
		if (p && p.tier === t) next.set(sid, p);
		else next.set(sid, {tier: t, since: prevRefreshAt});
	}
	return next;
}

// --- misc helpers -------------------------------------------------------

export function formatDuration(ms: number | null): string {
	if (ms === null) return '-';
	const m = Math.floor(ms / 60000);
	if (m < 1) return '<1m';
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
	const d = Math.floor(h / 24);
	return `${d}d${String(h % 24).padStart(2, '0')}h`;
}

export function formatTokens(n: number | undefined): string {
	if (n == null) return '-';
	if (n < 1000) return String(n);
	return `${Math.round(n / 1000)}k`;
}

/** First meaningful line of an assistant message. */
export function headLine(text: string | undefined): string | undefined {
	if (!text) return undefined;
	let inFence = false;
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line.startsWith('```') || line.startsWith('~~~')) {
			inFence = !inFence;
			continue;
		}
		if (inFence || !line) continue;
		if (line.startsWith('|')) continue;
		const cleaned = line
			.replace(/^#+\s*/, '')
			.replace(/^>\s*/, '')
			.replace(/\*\*|__/g, '')
			.trim();
		if (cleaned) return cleaned;
	}
	return undefined;
}

// --- filtering (dir candidates, wait menu) -----------------------------

function subsequence(hay: string, needle: string): {ok: boolean; contiguous: boolean} {
	const h = hay.toLowerCase();
	const n = needle.toLowerCase();
	if (h.includes(n)) return {ok: true, contiguous: true};
	let i = 0;
	for (const ch of h) if (ch === n[i]) i++;
	return {ok: i === n.length, contiguous: false};
}

export function filterCandidates<T>(
	items: T[],
	query: string,
	label: (t: T) => string,
	full: (t: T) => string,
): T[] {
	if (!query) return items;
	const scored: {t: T; score: number; i: number}[] = [];
	items.forEach((t, i) => {
		const m = subsequence(label(t), query);
		if (m.ok) {
			scored.push({t, score: m.contiguous ? 0 : 1, i});
			return;
		}
		if (full(t).toLowerCase().includes(query.toLowerCase()))
			scored.push({t, score: 2, i});
	});
	return scored.sort((a, b) => a.score - b.score || a.i - b.i).map(x => x.t);
}

/** Display names: basename, extended with parents only where they collide. */
export function displayNames(paths: string[]): Map<string, string> {
	const parts = new Map(paths.map(p => [p, p.split('/').filter(Boolean)]));
	const depth = new Map(paths.map(p => [p, 1]));
	const name = (p: string) => parts.get(p)!.slice(-depth.get(p)!).join('/') || '/';
	for (let round = 0; round < 20; round++) {
		const groups = new Map<string, string[]>();
		for (const p of paths) {
			const n = name(p);
			groups.set(n, [...(groups.get(n) ?? []), p]);
		}
		let changed = false;
		for (const ps of groups.values()) {
			if (ps.length < 2) continue;
			for (const p of ps) {
				if (depth.get(p)! < parts.get(p)!.length) {
					depth.set(p, depth.get(p)! + 1);
					changed = true;
				}
			}
		}
		if (!changed) break;
	}
	return new Map(paths.map(p => [p, name(p)]));
}

// --- `!` commands ------------------------------------------------------

// C0, DEL and C1 control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** `cmd   # note` → `cmd` (two or more spaces before `# `; a single space is kept, e.g. URLs) */
export function stripComment(cmd: string): string {
	return cmd.replace(/\s{2,}#(\s.*)?$/, '').trim();
}

/**
 * `! <command>` suggestions in an assistant message: lines starting with `! ` inside
 * fenced code blocks, and inline code spans `` `! <command>` `` elsewhere. Plain-text
 * `!` and anything containing control characters are ignored. Returns the commands
 * without `!` and without trailing comments, in order of appearance, deduplicated.
 */
export function bangCommands(text: string | undefined): string[] {
	if (!text) return [];
	const out: string[] = [];
	const add = (raw: string) => {
		if (CONTROL.test(raw)) return;
		const cmd = stripComment(raw);
		if (cmd && !out.includes(cmd)) out.push(cmd);
	};
	let fence: string | null = null;
	for (const line of text.split('\n')) {
		const t = line.replace(/\r$/, '');
		const m = t.match(/^\s*(`{3,}|~{3,})/);
		if (m) {
			if (!fence) fence = m[1]!;
			else if (m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
			continue;
		}
		if (fence) {
			const b = t.match(/^\s*! (.*)$/);
			if (b) add(b[1]!);
			continue;
		}
		for (const im of t.matchAll(/(?<!`)`! ([^`]+)`(?!`)/g)) add(im[1]!);
	}
	return out;
}
