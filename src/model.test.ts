import { describe, expect, it } from 'vitest';
import samples from '../docs/claude-agents-json.samples.json' with { type: 'json' };
import {
  cascadeTargets,
  classify,
  effectiveTiers,
  formatWaiting,
  group,
  sortSessions,
  tierLabel,
  toSessions,
  trackSince,
  unfinishedTargets,
  wouldCycle,
  waitedByOther,
  type RawRow,
  type Row,
  type Waits,
} from './model.js';
import { displayNames, filterItems } from './filter.js';
import { parseUsage } from './usage.js';

const bg = (o: Partial<RawRow> & { sessionId: string }): RawRow => ({ kind: 'background', id: o.sessionId.slice(0, 8), cwd: '/r', name: o.sessionId, ...o });

describe('tier rules (scenario 4)', () => {
  it('classifies the recorded sample rows', () => {
    const got = Object.fromEntries(samples.rows.map((r) => [r.name, classify(r as RawRow)]));
    expect(got['sample-working']).toEqual({ tier: 'Working' });
    expect(got['sample-done']).toEqual({ tier: 'Review' });
    expect(got['sample-idle-no-prompt']?.tier).toBe('Question');
    expect(got['sample-permission']).toEqual({ tier: 'Permission' });
    expect(got['sample-failed']).toEqual({ tier: 'Failed' });
    expect(got['sample-failed-after-stop']).toEqual({ tier: 'Failed' });
    expect(got['sample-stopped']).toBeNull();
    expect(got['sample-done-after-stop']).toEqual({ tier: 'Review' });
    expect(got['sample-interactive-busy']).toEqual({ tier: 'Working' });
  });
  it('drops interactive idle', () => {
    expect(classify({ kind: 'interactive', status: 'idle', pid: 1 })).toBeNull();
  });
  it('puts blocked without pid in Failed with a reason', () => {
    const c = classify({ kind: 'background', state: 'blocked' })!;
    expect(c.tier).toBe('Failed');
    expect(tierLabel(c)).toBe('Failed (no process)');
  });
  it('puts unmatched rows in Question with the raw value', () => {
    expect(tierLabel(classify({ kind: 'background', state: 'blocked', status: 'waiting', pid: 1, waitingFor: 'dialog open' })!)).toBe('Question (dialog open)');
    expect(classify({ kind: 'background', state: 'blocked', status: 'idle', pid: 1 })!.tier).toBe('Question');
    expect(classify({ kind: 'background', state: 'weird', pid: 1 })!.tier).toBe('Question');
    expect(tierLabel(classify({ kind: 'interactive', status: 'waiting', pid: 1 })!)).toBe('Question (waiting)');
    expect(classify({ kind: 'background', state: 'blocked', pid: 1, waitingFor: 'sandbox request' })!.tier).toBe('Sandbox');
    expect(classify({ kind: 'interactive', status: 'waiting', pid: 1, waitingFor: 'permission prompt' })!.tier).toBe('Permission');
  });
  it('dedupes by sessionId preferring the live row', () => {
    const rows: RawRow[] = [
      { kind: 'background', sessionId: 's1', id: 's1', state: 'done', name: 'x' },
      { kind: 'interactive', sessionId: 's1', pid: 9, status: 'waiting', waitingFor: 'permission prompt', name: 'x' },
    ];
    const { visible } = toSessions(rows);
    expect(visible).toHaveLength(1);
    expect(visible[0].baseTier).toBe('Permission');
    expect(visible[0].kind).toBe('interactive');
  });
  it('falls back to id when name is missing', () => {
    const { visible } = toSessions([{ kind: 'background', sessionId: 'abcdef12-x', id: 'abcdef12', state: 'failed' }]);
    expect(visible[0].name).toBe('abcdef12');
  });
});

describe('order and waiting time (scenarios 1-3)', () => {
  it('orders by ladder, unknown first, then longest waiting', () => {
    const rows = [
      { sid: 'a', name: 'a', tier: 'Review', since: 100 },
      { sid: 'b', name: 'b', tier: 'Permission', since: 500 },
      { sid: 'c', name: 'c', tier: 'Review', since: null },
      { sid: 'd', name: 'd', tier: 'Review', since: 50 },
      { sid: 'e', name: 'e', tier: 'Working', since: 10 },
      { sid: 'f', name: 'f', tier: 'Failed', since: 10 },
    ] as const;
    expect(sortSessions(rows.map((r) => ({ ...r }))).map((r) => r.sid)).toEqual(['b', 'f', 'c', 'd', 'a', 'e']);
  });
  it('first sighting is unknown, later changes count from the previous refresh', () => {
    const none = () => undefined;
    let t = trackSince(new Map(), new Map([['a', 'Review' as const]]), undefined, none);
    expect(t.get('a')!.since).toBeNull();
    t = trackSince(t, new Map([['a', 'Review' as const], ['b', 'Permission' as const]]), 1000, none);
    expect(t.get('a')!.since).toBeNull();
    expect(t.get('b')!.since).toBe(1000);
    t = trackSince(t, new Map([['a', 'Question' as const], ['b', 'Permission' as const]]), 2000, none);
    expect(t.get('a')!.since).toBe(2000);
    expect(t.get('b')!.since).toBe(1000);
  });
  it('uses the OTel last event outside Working', () => {
    const t = trackSince(new Map(), new Map([['a', 'Permission' as const], ['w', 'Working' as const]]), undefined, () => 1234);
    expect(t.get('a')!.since).toBe(1234);
    expect(t.get('w')!.since).toBeNull();
  });
  it('formats minutes', () => {
    expect(formatWaiting(null, 0)).toBe('?');
    expect(formatWaiting(0, 30000)).toBe('<1m');
    expect(formatWaiting(0, 5 * 60000)).toBe('5m');
    expect(formatWaiting(0, 125 * 60000)).toBe('2h05m');
  });
});

describe('wait-for (scenarios 18-21)', () => {
  const sessions = (spec: Record<string, RawRow['state'] | 'busy' | 'perm'>) =>
    toSessions(
      Object.entries(spec).map(([sid, st]) =>
        st === 'busy'
          ? bg({ sessionId: sid, state: 'working', status: 'busy', pid: 1 })
          : st === 'perm'
            ? bg({ sessionId: sid, state: 'blocked', status: 'waiting', waitingFor: 'permission prompt', pid: 1 })
            : bg({ sessionId: sid, state: st, status: 'idle', pid: 1 }),
      ),
    ).visible;
  const waits = (o: Record<string, string[]>): Waits => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

  it('A (done) waits while B runs, returns when B is done or gone', () => {
    const w = waits({ A: ['B'] });
    expect(effectiveTiers(sessions({ A: 'done', B: 'busy' }), w).get('A')).toBe('Waiting');
    expect(effectiveTiers(sessions({ A: 'done', B: 'done' }), w).get('A')).toBe('Review');
    expect(effectiveTiers(sessions({ A: 'done' }), w).get('A')).toBe('Review');
    expect(effectiveTiers(sessions({ A: 'done', B: 'stopped' }), w).get('A')).toBe('Review');
  });
  it('A that needs a human shows in its own tier', () => {
    const w = waits({ A: ['B'] });
    expect(effectiveTiers(sessions({ A: 'perm', B: 'busy' }), w).get('A')).toBe('Permission');
    expect(effectiveTiers(sessions({ A: 'failed', B: 'busy' }), w).get('A')).toBe('Failed');
    expect(effectiveTiers(sessions({ A: 'blocked', B: 'busy' }), w).get('A')).toBe('Question');
  });
  it('multiple targets: waits until all are finished and lists the unfinished', () => {
    const w = waits({ A: ['B', 'C'] });
    const tiers = effectiveTiers(sessions({ A: 'done', B: 'done', C: 'busy' }), w);
    expect(tiers.get('A')).toBe('Waiting');
    expect(unfinishedTargets('A', w, tiers)).toEqual(['C']);
  });
  it('nested: a target that itself waits is unfinished', () => {
    const w = waits({ A: ['B'], B: ['C'] });
    expect(effectiveTiers(sessions({ A: 'done', B: 'done', C: 'busy' }), w).get('A')).toBe('Waiting');
  });
  it('refuses cycles', () => {
    const w = waits({ A: ['B'], B: ['C'] });
    expect(wouldCycle(w, 'C', 'A')).toBe(true);
    expect(wouldCycle(w, 'A', 'A')).toBe(true);
    expect(wouldCycle(w, 'A', 'C')).toBe(false);
  });
  it('cascade includes descendants but not ones shared with other waiters', () => {
    const w = waits({ A: ['B', 'C'], B: ['D'], X: ['C'] });
    expect(cascadeTargets(w, 'A').sort()).toEqual(['B', 'D']);
  });
  it('held rows go to the hold group, last attached on top', () => {
    const rows: Row[] = sessions({ A: 'done', B: 'perm', C: 'busy' }).map((s) => ({ ...s, tier: s.baseTier, since: 0 }));
    const g = group(rows, 'C', new Map([['A', 'why']]));
    expect(g.last.map((r) => r.sid)).toEqual(['C']);
    expect(g.ladder.map((r) => r.sid)).toEqual(['B']);
    expect(g.hold.map((r) => r.sid)).toEqual(['A']);
  });
});

describe('nested trees (User Story 14)', () => {
  const mk = (sid: string, tier: Row['tier'], since: number | null = 0): Row =>
    ({ sid, id: sid, kind: 'background', cwd: '/r', name: sid, baseTier: tier, tier, since }) as Row;
  const waits = (o: Record<string, string[]>): Waits => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
  const view = (rows: Row[]) => rows.map((r) => `${'.'.repeat(r.depth ?? 0)}${r.sid}`);

  it('nests targets under the waiter and places the tree by its best member', () => {
    const rows = [mk('A', 'Waiting'), mk('B', 'Permission', 5), mk('C', 'Question'), mk('D', 'Review')];
    const g = group(rows, undefined, new Map(), waits({ A: ['B'] }));
    expect(view(g.ladder)).toEqual(['A', '.B', 'C', 'D']);
    expect(g.ladderTop).toBe('B');
  });
  it('a tree of working rows stays low', () => {
    const rows = [mk('A', 'Waiting'), mk('B', 'Working'), mk('C', 'Review')];
    expect(view(group(rows, undefined, new Map(), waits({ A: ['B'] })).ladder)).toEqual(['C', 'A', '.B']);
  });
  it('nests deeper levels and sorts siblings by the ladder', () => {
    const rows = [mk('A', 'Waiting'), mk('B', 'Working'), mk('C', 'Failed'), mk('D', 'Question')];
    expect(view(group(rows, undefined, new Map(), waits({ A: ['B', 'C'], B: ['D'] })).ladder)).toEqual(['A', '.C', '.B', '..D']);
  });
  it('holding the root moves the whole tree; a held member stays but does not count', () => {
    const rows = [mk('A', 'Waiting'), mk('B', 'Permission'), mk('C', 'Review')];
    const w = waits({ A: ['B'] });
    const g1 = group(rows, undefined, new Map([['A', '']]), w);
    expect(view(g1.hold)).toEqual(['A', '.B']);
    expect(view(g1.ladder)).toEqual(['C']);
    const g2 = group(rows, undefined, new Map([['B', '']]), w);
    expect(view(g2.ladder)).toEqual(['C', 'A', '.B']);
  });
  it('the tree holding the last attached session goes on top', () => {
    const rows = [mk('A', 'Waiting'), mk('B', 'Working'), mk('C', 'Permission')];
    const g = group(rows, 'B', new Map(), waits({ A: ['B'] }));
    expect(view(g.last)).toEqual(['A', '.B']);
    expect(view(g.ladder)).toEqual(['C']);
  });
  it('a target whose waiter is not listed stands alone', () => {
    const rows = [mk('B', 'Working')];
    expect(view(group(rows, undefined, new Map(), waits({ A: ['B'] })).ladder)).toEqual(['B']);
  });
  it('refuses a second waiter for the same target', () => {
    expect(waitedByOther(waits({ A: ['C'] }), 'X', 'C')).toBe(true);
    expect(waitedByOther(waits({ A: ['C'] }), 'A', 'C')).toBe(false);
  });
});

describe('candidates and usage', () => {
  it('shortest distinguishing names', () => {
    const m = displayNames(['/x/a/foo', '/x/b/foo', '/x/bar']);
    expect([...m.values()]).toEqual(['a/foo', 'b/foo', 'bar']);
  });
  it('filters by label subsequence, then path substring', () => {
    const items = ['/home/u/src/whatnext', '/home/u/src/other', '/home/u/wt/thing'];
    const label = (p: string) => p.split('/').pop()!;
    expect(filterItems(items, 'wn', label, (p) => p)).toEqual(['/home/u/src/whatnext']);
    expect(filterItems(items, 'src/o', label, (p) => p)).toEqual(['/home/u/src/other']);
    expect(filterItems(items, 'th', label, (p) => p)).toEqual(['/home/u/src/other', '/home/u/wt/thing']);
  });
  it('parses /usage lines', () => {
    const text = 'x\n\nCurrent session: 60% used · resets Sep 26 at 12:49am (Asia/Tokyo)\nCurrent week (all models): 40% used · resets Sep 29 at 9:59am (Asia/Tokyo)\n';
    expect(parseUsage(text, new Date(2026, 8, 26, 0, 10))).toEqual([
      { label: 'session', percent: 60, resets: '12:49am' },
      { label: 'week (all models)', percent: 40, resets: 'Sep 29 9:59am' },
    ]);
  });
});
