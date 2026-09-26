import {describe, expect, it} from 'vitest';
import {
	buildView,
	canLink,
	deriveTiers,
	displayNames,
	filterCandidates,
	headLine,
	toSessions,
	updateTracks,
	type RawRow,
	type Waits,
} from './model.js';

const bg = (id: string, extra: Partial<RawRow>): RawRow => ({
	kind: 'background',
	sessionId: `${id}-0000`,
	id,
	cwd: '/repo',
	name: id,
	pid: 1,
	...extra,
});
const sid = (id: string) => `${id}-0000`;

function view(rows: RawRow[], opts: {waits?: Waits; holds?: Map<string, string>; since?: Record<string, number | null>; last?: string} = {}) {
	const sessions = toSessions(rows);
	const waits = opts.waits ?? new Map();
	const tiers = deriveTiers(sessions, waits);
	const since = new Map<string, number | null>();
	for (const s of sessions) since.set(s.sessionId, opts.since?.[s.id ?? ''] ?? 0);
	const v = buildView({
		sessions,
		tiers,
		since,
		waits,
		holds: opts.holds ?? new Map(),
		lastAttached: opts.last ? sid(opts.last) : null,
	});
	const name = (n: {sid: string; prefix: string}) => n.prefix + sessions.find(s => s.sessionId === n.sid)!.displayName;
	return {
		tiers,
		sessions,
		last: v.last?.map(name) ?? null,
		ladder: v.ladder.map(name),
		hold: v.hold.map(name),
		topPick: v.topPick,
	};
}

describe('ladder (scenario 1, 3, 4)', () => {
	it('orders by tier', () => {
		const v = view([
			bg('work', {state: 'working', status: 'busy'}),
			bg('rev', {state: 'done', status: 'idle'}),
			bg('perm', {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'}),
			bg('fail', {state: 'failed', status: 'idle'}),
			bg('sbx', {state: 'blocked', status: 'waiting', waitingFor: 'sandbox request'}),
			bg('q', {state: 'blocked', status: 'waiting', waitingFor: 'input needed'}),
		]);
		expect(v.ladder).toEqual(['perm', 'q', 'sbx', 'fail', 'rev', 'work']);
	});

	it('puts unknown waiting time first within a tier, then longest wait', () => {
		const v = view(
			[bg('a', {state: 'done'}), bg('b', {state: 'done'}), bg('c', {state: 'done'})],
			{since: {a: 100, b: null, c: 50}},
		);
		expect(v.ladder).toEqual(['b', 'c', 'a']);
	});

	it('dedupes by sessionId preferring the live row', () => {
		const rows: RawRow[] = [
			{kind: 'background', sessionId: 'x-0000', id: 'x', cwd: '/r', state: 'done'},
			{kind: 'interactive', sessionId: 'x-0000', cwd: '/r', pid: 9, status: 'waiting', waitingFor: 'permission prompt'},
		];
		const s = toSessions(rows);
		expect(s).toHaveLength(1);
		expect(s[0]!.kind).toBe('interactive');
		expect(s[0]!.tier).toBe('Permission');
	});

	it('handles excluded and odd rows', () => {
		const s = toSessions([
			{kind: 'interactive', sessionId: 'i', cwd: '/', pid: 1, status: 'idle'},
			bg('stopped', {state: 'stopped', pid: undefined}),
			bg('dead', {state: 'blocked', pid: undefined}),
			bg('odd', {state: 'blocked', status: 'waiting', waitingFor: 'dialog open'}),
			bg('blk', {state: 'blocked', status: 'idle'}),
			bg('int', {state: 'working', status: 'idle'}),
		]);
		const t = Object.fromEntries(s.map(x => [x.displayName, [x.tier, x.reason]]));
		expect(t['i']).toEqual([null, undefined]);
		expect(t['stopped']).toEqual([null, undefined]);
		expect(t['dead']).toEqual(['Failed', 'no process']);
		expect(t['odd']).toEqual(['Question', 'dialog open']);
		expect(t['blk']).toEqual(['Question', 'blocked']);
		expect(t['int']).toEqual(['Question', undefined]);
	});
});

describe('waiting (scenario 17-21)', () => {
	const waits: Waits = new Map([[sid('A'), new Set([sid('B')])]]);

	it('A waits while B works; group sits at B position', () => {
		const v = view(
			[bg('A', {state: 'done'}), bg('B', {state: 'working', status: 'busy'}), bg('R', {state: 'done'})],
			{waits},
		);
		expect(v.tiers.get(sid('A'))).toBe('Waiting');
		expect(v.ladder).toEqual(['R', 'A', '└ B']);
	});

	it('A returns to its tier when B is done or gone', () => {
		let v = view([bg('A', {state: 'done'}), bg('B', {state: 'done'})], {waits});
		expect(v.tiers.get(sid('A'))).toBe('Review');
		v = view([bg('A', {state: 'done'})], {waits});
		expect(v.tiers.get(sid('A'))).toBe('Review');
		v = view([bg('A', {state: 'done'}), bg('B', {state: 'stopped', pid: undefined})], {waits});
		expect(v.tiers.get(sid('A'))).toBe('Review');
	});

	it('A keeps its own tier when it needs a human (19)', () => {
		const v = view(
			[bg('A', {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'}), bg('B', {state: 'working', status: 'busy'})],
			{waits},
		);
		expect(v.tiers.get(sid('A'))).toBe('Permission');
	});

	it('multiple targets: waiting until all done, nested (20)', () => {
		const w: Waits = new Map([[sid('A'), new Set([sid('B'), sid('C')])]]);
		const v = view(
			[bg('A', {state: 'done'}), bg('B', {state: 'done'}), bg('C', {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'})],
			{waits: w},
		);
		expect(v.tiers.get(sid('A'))).toBe('Waiting');
		expect(v.ladder).toEqual(['A', '├ C', '└ B']);
	});

	it('no cycles, one waiter per target', () => {
		expect(canLink(waits, sid('B'), sid('A'))).toBe(false);
		expect(canLink(waits, sid('C'), sid('B'))).toBe(false);
		expect(canLink(waits, sid('A'), sid('C'))).toBe(true);
		expect(canLink(waits, sid('A'), sid('A'))).toBe(false);
	});

	it('hold: target stays in tree, held root moves group (21)', () => {
		let v = view(
			[bg('A', {state: 'done'}), bg('B', {state: 'working', status: 'busy'})],
			{waits, holds: new Map([[sid('B'), '']])},
		);
		expect(v.ladder).toEqual(['A', '└ B']);
		expect(v.hold).toEqual([]);
		v = view(
			[bg('A', {state: 'done'}), bg('B', {state: 'working', status: 'busy'}), bg('R', {state: 'done'})],
			{waits, holds: new Map([[sid('A'), '']])},
		);
		expect(v.ladder).toEqual(['R']);
		expect(v.hold).toEqual(['A', '└ B']);
	});

	it('last attached group is pulled out of the ladder', () => {
		const v = view(
			[bg('A', {state: 'done'}), bg('B', {state: 'working', status: 'busy'}), bg('P', {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'})],
			{waits, last: 'B'},
		);
		expect(v.last).toEqual(['A', '└ B']);
		expect(v.ladder).toEqual(['P']);
		expect(v.topPick).toBe(sid('P'));
	});
});

describe('tracks (scenario 2, 3)', () => {
	it('first refresh unknown, later entries use previous refresh time', () => {
		const t1 = updateTracks(new Map(), new Map([['a', 'Review']]), null);
		expect(t1.get('a')!.since).toBeNull();
		const t2 = updateTracks(t1, new Map([['a', 'Review'], ['b', 'Working']]), 1000);
		expect(t2.get('a')!.since).toBeNull();
		expect(t2.get('b')!.since).toBe(1000);
		const t3 = updateTracks(t2, new Map([['a', 'Permission'], ['b', 'Working']]), 2000);
		expect(t3.get('a')!.since).toBe(2000);
		expect(t3.get('b')!.since).toBe(1000);
	});
});

describe('helpers', () => {
	it('headLine skips fences, tables and markers', () => {
		expect(headLine('\n```\ncode\n```\n| a | b |\n## **Done** here\nmore')).toBe('Done here');
	});
	it('displayNames disambiguates', () => {
		const m = displayNames(['/x/a/foo', '/x/b/foo', '/x/bar']);
		expect([...m.values()]).toEqual(['a/foo', 'b/foo', 'bar']);
	});
	it('filter ranks label matches above path matches', () => {
		const items = ['/src/whatnext', '/wn/other', '/abc/wnx'];
		const r = filterCandidates(items, 'wn', p => p.split('/').pop()!, p => p);
		expect(r).toEqual(['/abc/wnx', '/src/whatnext', '/wn/other']);
	});
});
