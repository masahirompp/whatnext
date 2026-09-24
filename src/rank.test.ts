import { describe, expect, it } from 'vitest';
import { AgentRow, cursorAfterAttach, observe, tierLabel } from './rank.js';

const bg = (id: string, extra: Partial<AgentRow>): AgentRow => ({
  id, sessionId: `s-${id}`, kind: 'background', cwd: '/x', name: id, ...extra,
});
const tty = (sid: string, extra: Partial<AgentRow>): AgentRow => ({
  sessionId: sid, kind: 'interactive', cwd: '/x', name: sid, ...extra,
});

const labels = (rows: AgentRow[], seen = new Map(), prev: number | null = null) =>
  observe(rows, seen, prev).entries.map((e) => [e.row.name, tierLabel(e)]);

describe('ladder order (scenario 1)', () => {
  it('orders by tier', () => {
    const rows = [
      bg('work', { state: 'working', status: 'busy', pid: 1 }),
      bg('rev', { state: 'done', status: 'idle', pid: 2 }),
      bg('fail', { state: 'failed', status: 'idle', pid: 3 }),
      bg('sand', { state: 'blocked', status: 'waiting', waitingFor: 'sandbox request', pid: 4 }),
      bg('q', { state: 'blocked', status: 'waiting', waitingFor: 'input needed', pid: 5 }),
      tty('perm', { status: 'waiting', waitingFor: 'permission prompt', pid: 6 }),
    ];
    expect(labels(rows)).toEqual([
      ['perm', 'Permission'], ['q', 'Question'], ['sand', 'Sandbox'],
      ['fail', 'Failed'], ['rev', 'Review'], ['work', 'Working'],
    ]);
  });
});

describe('row rules (scenario 4)', () => {
  it('dedupes by sessionId preferring the live process', () => {
    const rows = [
      bg('a', { state: 'done' }),
      { ...tty('s-a', { status: 'waiting', waitingFor: 'permission prompt', pid: 9 }), name: 'a-tty' },
    ];
    expect(labels(rows)).toEqual([['a-tty', 'Permission']]);
  });
  it('prefers background when neither has a pid', () => {
    const rows = [tty('s-a', { status: 'busy' }), bg('a', { state: 'done' })];
    expect(labels(rows)).toEqual([['a', 'Review']]);
  });
  it('hides interactive idle and stopped', () => {
    expect(labels([tty('t', { status: 'idle', pid: 1 }), bg('s', { state: 'stopped' })])).toEqual([]);
  });
  it('puts pid-less blocked in Failed', () => {
    expect(labels([bg('b', { state: 'blocked' })])).toEqual([['b', 'Failed (no process)']]);
  });
  it('puts unmatched rows in Question with the raw value', () => {
    const rows = [
      bg('w', { state: 'blocked', status: 'waiting', waitingFor: 'dialog open', pid: 1 }),
      bg('p', { state: 'blocked', status: 'idle', pid: 2 }),
      bg('u', { state: 'weird', pid: 3 }),
    ];
    expect(labels(rows).map((x) => x[1]).sort()).toEqual(
      ['Question (blocked)', 'Question (dialog open)', 'Question (weird)'],
    );
  });
});

describe('wait time (scenarios 2, 3)', () => {
  it('unknown on first refresh and first within tier; later arrivals counted from previous refresh', () => {
    const first = observe([bg('old', { state: 'done' })], new Map(), null);
    expect(first.entries[0].since).toBeNull();
    const second = observe(
      [bg('old', { state: 'done' }), bg('new', { state: 'done' })], first.seen, 1000,
    );
    expect(second.entries.map((e) => [e.row.name, e.since])).toEqual([['old', null], ['new', 1000]]);
    const third = observe(
      [bg('old', { state: 'done' }), bg('new', { state: 'done' }), bg('newer', { state: 'done' })],
      second.seen, 2000,
    );
    expect(third.entries.map((e) => e.row.name)).toEqual(['old', 'new', 'newer']);
  });
  it('resets when the tier changes', () => {
    const a = observe([bg('x', { state: 'working', status: 'busy', pid: 1 })], new Map(), null);
    const b = observe([bg('x', { state: 'done', pid: 1 })], a.seen, 5000);
    expect(b.entries[0].since).toBe(5000);
  });
});

describe('cursor after attach (scenario 5)', () => {
  it('skips the top row if it is the session just left with the same tier', () => {
    const { entries } = observe([bg('a', { state: 'done' }), bg('b', { state: 'done' })], new Map(), null);
    const top = entries[0];
    expect(cursorAfterAttach(entries, { sessionId: top.row.sessionId, key: top.tier })).toBe(1);
    expect(cursorAfterAttach(entries, { sessionId: top.row.sessionId, key: 'Permission' })).toBe(0);
    expect(cursorAfterAttach(entries.slice(0, 1), { sessionId: top.row.sessionId, key: top.tier })).toBe(0);
  });
});
