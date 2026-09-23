import { describe, expect, it } from 'vitest';
import { Observer, formatDuration, type AgentRow } from './ladder.js';

// `claude agents --json --all` の出力を模した固定データ
const rows: AgentRow[] = [
  { id: 'a1', cwd: '/w/a', kind: 'background', sessionId: 's-done', name: 'done', state: 'done', status: 'idle', pid: 1 },
  { id: 'a2', cwd: '/w/b', kind: 'background', sessionId: 's-perm-bg', state: 'blocked', status: 'waiting', waitingFor: 'permission prompt', pid: 2 },
  { cwd: '/w/c', kind: 'interactive', sessionId: 's-perm-tty', status: 'waiting', waitingFor: 'permission prompt', pid: 3 },
  { id: 'a4', cwd: '/w/d', kind: 'background', sessionId: 's-question', state: 'blocked', status: 'waiting', waitingFor: 'input needed', pid: 4 },
  { id: 'a5', cwd: '/w/e', kind: 'background', sessionId: 's-sandbox', state: 'blocked', status: 'waiting', waitingFor: 'sandbox request', pid: 5 },
  { id: 'a6', cwd: '/w/f', kind: 'background', sessionId: 's-failed', state: 'failed', status: null, waitingFor: null, pid: null },
  { id: 'a7', cwd: '/w/g', kind: 'background', sessionId: 's-orphan', state: 'blocked', status: null, waitingFor: null, pid: null },
  { id: 'a8', cwd: '/w/h', kind: 'background', sessionId: 's-working', state: 'working', status: 'busy', pid: 8 },
  { cwd: '/w/l', kind: 'interactive', sessionId: 's-busy-tty', status: 'busy', pid: 12 },
  { id: 'a9', cwd: '/w/i', kind: 'background', sessionId: 's-stopped', state: 'stopped', status: null, pid: null },
  { cwd: '/w/j', kind: 'interactive', sessionId: 's-idle-tty', status: 'idle', pid: 10 },
];

const tiersOf = (items: { tier: string }[]) => items.map((i) => i.tier);
const idsOf = (items: { row: AgentRow }[]) => items.map((i) => i.row.sessionId);

describe('優先度ラダー(完了条件1・4)', () => {
  it('段の順に並ぶ', () => {
    const items = new Observer().observe(rows, 1000);
    expect(tiersOf(items)).toEqual([
      'permission', 'permission', 'question', 'sandbox', 'failed', 'failed', 'review', 'working', 'working',
    ]);
  });

  it('各行に段、待機の理由、cwd が付く', () => {
    const items = new Observer().observe(rows, 1000);
    const perm = items.find((i) => i.row.sessionId === 's-perm-tty')!;
    expect(perm).toMatchObject({ tier: 'permission', reason: 'permission prompt' });
    expect(perm.row.cwd).toBe('/w/c');
  });

  it('interactive の idle と stopped は出ない', () => {
    const ids = idsOf(new Observer().observe(rows, 1000));
    expect(ids).not.toContain('s-idle-tty');
    expect(ids).not.toContain('s-stopped');
  });

  it('pid のない blocked は失敗の段(4位)に置かれる', () => {
    const items = new Observer().observe(rows, 1000);
    expect(items.find((i) => i.row.sessionId === 's-orphan')).toMatchObject({ tier: 'failed' });
  });

  it('同じ sessionId が二重に出ても1行にまとまり、background の行を採る', () => {
    const dup: AgentRow[] = [
      { cwd: '/w/k', kind: 'interactive', sessionId: 's-dup', status: 'busy', pid: 11 },
      { id: 'b1', cwd: '/w/k', kind: 'background', sessionId: 's-dup', state: 'done' },
    ];
    const items = new Observer().observe(dup, 1000);
    expect(items).toHaveLength(1);
    expect(items[0].row).toMatchObject({ kind: 'background', id: 'b1' });
  });

  it('対話セッションの権限待ちも state なしで判定される', () => {
    const items = new Observer().observe([rows[2]], 1000);
    expect(items[0].tier).toBe('permission');
  });
});

describe('待機時間(完了条件2・3)', () => {
  it('起動して最初の更新で見えた行は不明(?)になる', () => {
    const items = new Observer().observe(rows, 1000);
    expect(items.every((i) => i.since === null)).toBe(true);
    expect(formatDuration(null)).toBe('?');
  });

  it('更新の間に今の段に入った行は、前回の更新時刻から数える', () => {
    const obs = new Observer();
    obs.observe([rows[7]], 1000); // 稼働中
    const items = obs.observe([{ ...rows[7], state: 'done', status: 'idle' }], 61000);
    expect(items[0]).toMatchObject({ tier: 'review', since: 1000 });
  });

  it('同じ段に居続ける行は、入ったときの時刻を保つ', () => {
    const obs = new Observer();
    obs.observe([], 0);
    obs.observe([rows[0]], 1000);
    const items = obs.observe([rows[0]], 2000);
    expect(items[0].since).toBe(0);
  });

  it('不明の行は同じ段の先頭に置かれ、それ以外は待機時間の長い順', () => {
    const obs = new Observer();
    const older = { ...rows[0], sessionId: 's-old', id: 'o' };
    const newer = { ...rows[0], sessionId: 's-new', id: 'n' };
    obs.observe([older], 1000); // s-old は不明
    obs.observe([older, { ...newer, state: 'working', status: 'busy' }], 2000);
    // s-new は 2000〜3000 の間にレビュー待ちに入った
    const late = { ...rows[0], sessionId: 's-late', id: 'l' };
    obs.observe([older, newer], 3000); // s-new: since 2000
    const items = obs.observe([older, newer, late], 4000); // s-late: since 3000
    expect(idsOf(items)).toEqual(['s-old', 's-new', 's-late']);
    expect(items.map((i) => i.since)).toEqual([null, 2000, 3000]);
  });
});

describe('formatDuration', () => {
  it('単位を切り替える', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(125_000)).toBe('2m');
    expect(formatDuration(3_900_000)).toBe('1h05m');
    expect(formatDuration(90_000_000)).toBe('1d1h');
  });
});
