import {describe, expect, it} from 'vitest';
import {
  formatCtx,
  formatUsage,
  formatWaiting,
  formatWhere,
  render,
  type ScreenModel,
  type ScreenRow,
} from '../../src/screen/render.js';
import {stripAnsi, width} from '../../src/screen/text.js';

function row(name: string, extra: Partial<ScreenRow> = {}): ScreenRow {
  return {
    key: name,
    name,
    tty: false,
    midHold: false,
    depth: 0,
    lastChain: [],
    hasChildren: false,
    tier: 'review',
    status: 'Review',
    since: 0,
    notes: [],
    where: {repo: 'app', worktree: false},
    ...extra,
  };
}

function model(extra: Partial<ScreenModel> = {}): ScreenModel {
  return {
    cols: 100,
    rows: 30,
    upNext: [],
    cursor: null,
    asOf: 5 * 60000,
    messages: [],
    help: 'q quit',
    ...extra,
  };
}

const plain = (lines: string[]) => lines.map(stripAnsi);

describe('表記', () => {
  it('待機時間は分を最小の単位にし、不明は -', () => {
    expect(formatWaiting(null, 0)).toBe('-');
    expect(formatWaiting(0, 59000)).toBe('<1m');
    expect(formatWaiting(0, 5 * 60000)).toBe('5m');
    expect(formatWaiting(0, 125 * 60000)).toBe('2h05m');
    expect(formatWaiting(0, 26 * 3600000)).toBe('1d02h');
  });

  it('CTX は k で、分からなければ -', () => {
    expect(formatCtx(undefined)).toBe('-');
    expect(formatCtx(36_400)).toBe('36k');
    expect(formatCtx(1_234_000)).toBe('1.2M');
  });

  it('WHERE はリポジトリ、ブランチ、(wt)、PR の順', () => {
    expect(
      formatWhere({repo: 'app', branch: 'fix-login', worktree: true, pr: {number: 12, state: 'open'}}, false),
    ).toBe('app fix-login (wt) #12 (open)');
  });

  it('Usage は枠ごとに並べる', () => {
    expect(
      stripAnsi(
        formatUsage([
          {label: 'session', percent: 42, resets: '2:09pm'},
          {label: 'week (all models)', percent: 85, resets: 'Sep 29 9:59am'},
        ]),
      ),
    ).toBe('session 42% (resets 2:09pm) · week (all models) 85% (resets Sep 29 9:59am)');
  });
});

describe('一覧の画面', () => {
  it('列は SESSION / STATUS / WHERE / CTX / WAITING の順 (シナリオ 1)', () => {
    const lines = plain(render(model({upNext: [row('fix-login', {ctx: 91000})], cursor: 'fix-login'})));
    expect(lines[0]).toMatch(/^ {2}SESSION +STATUS +WHERE +CTX +WAITING$/);
    expect(lines[1]).toMatch(/^> fix-login +Review +app +91k +5m$/);
  });

  it('対話セッションには (tty)、途中の保留には (on hold) を添える', () => {
    const lines = plain(render(model({upNext: [row('a', {tty: true}), row('b', {midHold: true})]})));
    expect(lines.join('\n')).toContain('a (tty)');
    expect(lines.join('\n')).toContain('b (on hold)');
  });

  it('待ち先を入れ子の線で並べ、注記の行にも縦線を引く', () => {
    const lines = plain(
      render(
        model({
          upNext: [
            row('A', {hasChildren: true, notes: ['↳ note A']}),
            row('B', {depth: 1, lastChain: [false], notes: ['→ b']}),
            row('C', {depth: 1, lastChain: [true]}),
          ],
        }),
      ),
    );
    expect(lines.slice(1, 6)).toEqual([
      expect.stringMatching(/^ {2}A /),
      '  │ ↳ note A',
      expect.stringMatching(/^ {2}├ B /),
      '  │   → b',
      expect.stringMatching(/^ {2}└ C /),
    ]);
  });

  it('組の見出しは先頭の組か保留の組があるときだけ出す', () => {
    const none = plain(render(model({upNext: [row('a')]}))).join('\n');
    expect(none).not.toContain('Up next');
    const both = plain(render(model({lastAttached: [row('l')], upNext: [row('a')], onHold: [row('h')]})));
    expect(both.filter(l => /^ {2}(Last attached|Up next|On hold)$/.test(l))).toEqual([
      '  Last attached',
      '  Up next',
      '  On hold',
    ]);
  });

  it('どの行も端末の幅に収まり、行数は高さを超えない', () => {
    const rows = Array.from({length: 40}, (_, i) =>
      row(`session-with-a-long-name-${i}`, {notes: ['とても長い日本語の一言が続きます。'.repeat(5)]}),
    );
    const out = render(model({cols: 40, rows: 12, upNext: rows, cursor: rows[20]?.key ?? null}));
    expect(out.length).toBeLessThanOrEqual(12);
    for (const l of out) expect(width(stripAnsi(l))).toBeLessThanOrEqual(40);
  });

  it('収まらないときは選んだ行が見えるようにスクロールし、通し番号を出す。Last attached と Up next の見出しは固定する (シナリオ 24)', () => {
    const rows = Array.from({length: 30}, (_, i) => row(`s${i}`));
    const lines = plain(
      render(model({rows: 15, lastAttached: [row('last')], upNext: rows, cursor: 's25', help: 'help'})),
    );
    expect(lines[0]).toContain('SESSION');
    expect(lines[1]).toBe('  Last attached');
    expect(lines[2]).toMatch(/^ {2}last /);
    expect(lines[4]).toBe('  Up next');
    expect(lines.some(l => l.startsWith('> s25'))).toBe(true);
    expect(lines).toContain('  27/31');
    expect(lines.at(-1)).toBe('help');
    expect(lines.length).toBe(15);
  });

  it('収まるときは通し番号を出さない', () => {
    const lines = plain(render(model({upNext: [row('a'), row('b')], cursor: 'b'})));
    expect(lines.some(l => /\d+\/\d+/.test(l))).toBe(false);
  });

  it('端末がとても低くてもヘッダを押し出さない', () => {
    const rows = Array.from({length: 10}, (_, i) => row(`s${i}`));
    const lines = plain(render(model({rows: 4, upNext: rows, cursor: 's5', messages: ['m'], help: 'h'})));
    expect(lines[0]).toContain('SESSION');
    expect(lines.length).toBe(4);
  });

  it('削除中の行は Deleting... と出る', () => {
    const lines = plain(render(model({upNext: [row('a', {transient: 'deleting', notes: ['x']})]})));
    expect(lines[1]).toMatch(/Deleting\.\.\./);
  });

  it('一覧の代わりの文言', () => {
    const lines = plain(render(model({placeholder: 'No sessions.'})));
    expect(lines).toContain('  No sessions.');
  });
});
