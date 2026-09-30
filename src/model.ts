// 段(待ちの導出を含む)、並び、組(待ち先の木・Last attached・On hold)を決める純粋な処理。
import {TIER_ORDER, type Tier} from './agents.js';

export type Ranked = {
	sid: string;
	name: string;
	own: Tier; // --json の行だけで決まる段
	since: number | null; // 今の段に入った時刻(稼働中は稼働を始めた時刻)。null は分からない
};

export type Waits = Map<string, Set<string>>; // 待ち元 → 待ち先

export function parentOf(waits: Waits, sid: string): string | undefined {
	for (const [p, cs] of waits) if (cs.has(sid)) return p;
	return undefined;
}

// 待ち先が「終わった」段。ほかに、一覧に出ていないものも終わったとみなす
const FINISHED: ReadonlySet<Tier> = new Set(['review', 'stopped']);

// 待ち元の段を導く。待ち元がレビュー待ちに当たり、待ち先のどれかが終わっていなければ待ち。
export function deriveTiers<T extends Ranked>(visible: Map<string, T>, waits: Waits): Map<string, Tier> {
	const out = new Map<string, Tier>();
	const visiting = new Set<string>();
	const tierOf = (sid: string): Tier | undefined => {
		const s = visible.get(sid);
		if (!s) return undefined;
		const memo = out.get(sid);
		if (memo) return memo;
		if (visiting.has(sid)) return s.own;
		visiting.add(sid);
		let t: Tier = s.own;
		if (s.own === 'review') {
			for (const c of waits.get(sid) ?? []) {
				const ct = tierOf(c);
				if (ct !== undefined && !FINISHED.has(ct)) {
					t = 'waiting';
					break;
				}
			}
		}
		visiting.delete(sid);
		out.set(sid, t);
		return t;
	};
	for (const sid of visible.keys()) tierOf(sid);
	return out;
}

export type RankKey = [number, number, number, string];

// 段、待機時間が分からないもの、長く待っているもの、名前の順
export function rankKey(tier: Tier, since: number | null, name: string): RankKey {
	return [TIER_ORDER.indexOf(tier), since === null ? 0 : 1, since ?? 0, name];
}

export function compareRank(a: RankKey, b: RankKey): number {
	for (let i = 0; i < 3; i++) {
		const d = (a[i] as number) - (b[i] as number);
		if (d !== 0) return d;
	}
	return a[3].localeCompare(b[3]);
}

type Tree<T> = {s: T; children: Tree<T>[]; best: RankKey};

export type Node<T> = {
	s: T;
	depth: number;
	rowPrefix: string; // SESSION の列の中の線(`├ ` など)
	notePrefix: string; // 注記の行の線
	root: string;
};

export type Layout<T> = {last: Node<T>[]; ladder: Node<T>[]; hold: Node<T>[]};

export function layout<T extends Ranked>(
	visible: Map<string, T>,
	tiers: Map<string, Tier>,
	waits: Waits,
	holds: Set<string>,
	lastAttached: string | undefined,
): Layout<T> {
	const key = (s: T) => rankKey(tiers.get(s.sid) ?? s.own, s.since, s.name);
	const build = (s: T, isRoot: boolean): Tree<T> => {
		const children = [...(waits.get(s.sid) ?? [])]
			.map(c => visible.get(c))
			.filter((c): c is T => !!c)
			.map(c => build(c, false))
			.sort((a, b) => compareRank(a.best, b.best));
		// 途中の保留の行は、組の位置を決めるときに数えない
		let best: RankKey | undefined = isRoot || !holds.has(s.sid) ? key(s) : undefined;
		for (const c of children) if (!best || compareRank(c.best, best) < 0) best = c.best;
		return {s, children, best: best ?? [99, 1, Number.MAX_SAFE_INTEGER, s.name]};
	};
	const roots = [...visible.values()].filter(s => {
		const p = parentOf(waits, s.sid);
		return !p || !visible.has(p);
	});
	const trees = roots.map(r => build(r, true)).sort((a, b) => compareRank(a.best, b.best));

	const contains = (t: Tree<T>, sid: string): boolean => t.s.sid === sid || t.children.some(c => contains(c, sid));
	const lastTree = lastAttached && visible.has(lastAttached) ? trees.find(t => contains(t, lastAttached) && !holds.has(t.s.sid)) : undefined;

	const out: Layout<T> = {last: [], ladder: [], hold: []};
	for (const t of trees) {
		const target = t === lastTree ? out.last : holds.has(t.s.sid) ? out.hold : out.ladder;
		flatten(t, target, 0, '', t.s.sid);
	}
	return out;
}

function flatten<T>(t: Tree<T>, out: Node<T>[], depth: number, base: string, root: string, last = true) {
	const rowPrefix = depth === 0 ? '' : base + (last ? '└ ' : '├ ');
	const childBase = depth === 0 ? '' : base + (last ? '  ' : '│ ');
	const notePrefix = childBase + (t.children.length ? '│ ' : '  ');
	out.push({s: t.s, depth, rowPrefix, notePrefix, root});
	t.children.forEach((c, i) => flatten(c, out, depth + 1, childBase, root, i === t.children.length - 1));
}

// 組の中で最も順位の高い行(組の位置を決めた行。途中の保留の行は数えない)
export function bestOf<T extends Ranked>(nodes: Node<T>[], tiers: Map<string, Tier>, holds: Set<string>): T | undefined {
	let best: T | undefined;
	let bestKey: RankKey | undefined;
	for (const n of nodes) {
		if (n.depth > 0 && holds.has(n.s.sid)) continue;
		const k = rankKey(tiers.get(n.s.sid) ?? n.s.own, n.s.since, n.s.name);
		if (!bestKey || compareRank(k, bestKey) < 0) {
			best = n.s;
			bestKey = k;
		}
	}
	return best ?? nodes[0]?.s;
}

// 待ち元 a の待ち先の候補から外すもの: a 自身、結ぶと一周するもの(a の祖先)、ほかの待ち元の待ち先
export function canWaitFor(waits: Waits, a: string, x: string): boolean {
	if (a === x) return false;
	for (let p = parentOf(waits, a); p; p = parentOf(waits, p)) if (p === x) return false;
	const px = parentOf(waits, x);
	return !px || px === a;
}

export function descendants(waits: Waits, sid: string): string[] {
	const out: string[] = [];
	for (const c of waits.get(sid) ?? []) out.push(c, ...descendants(waits, c));
	return out;
}
