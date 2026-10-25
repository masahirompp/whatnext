import {describe, expect, it} from 'vitest';
import {stripAnsi, width} from '../../lib/text/text.js';
import {formatCtx, formatWaiting, menuLines, render} from '../../src/screen/screen.js';
import type {Screen, ScreenRow} from '../../src/screen/types.js';

const row = (sid: string, over: Partial<ScreenRow> = {}): ScreenRow => ({
  sid,
  name: sid,
  status: 'Review',
  tone: 'review',
  where: {},
  depth: 0,
  last: true,
  ancestorsLast: [],
  hasChildren: false,
  ...over,
});

const plain = (s: Screen) => render(s).map(l => stripAnsi(l).trimEnd());

const example: Screen = {
  width: 100,
  height: 20,
  cursor: 'fix-login',
  groups: [
    {
      title: 'app',
      rows: [
        row('fix-login', {
          where: {branch: 'fix-login', pr: {number: 12, state: 'open'}},
          ctx: 91000,
          waiting: 5 * 60000,
          hasChildren: true,
          line: '変更点は3つです。',
        }),
        row('review fix-login', {
          status: 'Working',
          tone: 'working',
          where: {branch: 'fix-login', worktree: true},
          ctx: 40000,
          waiting: 2 * 60000,
          depth: 1,
          last: false,
          line: '→ レビューして',
          hasChildren: true,
        }),
        row('review-loop-07', {
          marker: 'sub',
          status: 'Working',
          tone: 'working',
          depth: 2,
          last: true,
          ancestorsLast: [false],
          line: '→ iterate',
        }),
        row('bump shared lib', {status: 'Stopped', tone: 'stopped', where: {repo: 'lib'}, waiting: 3600000, depth: 1}),
        row('add metrics', {
          status: 'Working',
          tone: 'working',
          ctx: 12000,
          waiting: 10000,
          running: ['npm run e2e', 'make'],
        }),
        row('alpha', {ctx: 8000, waiting: 3 * 3600000, note: "waiting for Bob's API change", done: ['x', 'y']}),
      ],
    },
    {
      title: 'infra',
      rows: [
        row('refactor the auth middleware so that it is long enough to cut', {
          status: 'Permission',
          tone: 'permission',
          where: {branch: 'auth-mw'},
          ctx: 22000,
          waiting: 9 * 60000,
          line: 'Bash: rm -rf node_modules',
        }),
      ],
    },
  ],
  usage: 'session 42% · week 18%',
  keys: '↑↓ select · Enter attach · e note · f wait for',
};

describe('画面の組み立て', () => {
  it('区切りの見出し、入れ子の線、注記を描く', () => {
    expect(plain(example)).toEqual([
      '  SESSION                                           STATUS      WHERE                 CTX  WAITING',
      '── app ─────────────────────────────────────────────────────────────────────────────────────────────',
      '> fix-login                                         Review      fix-login #12 (open)  91k       5m',
      '  │ 変更点は3つです。',
      '  ├ review fix-login                                Working     fix-login (wt)        40k       2m',
      '  │ │ → レビューして',
      '  │ └ review-loop-07 (sub)                          Working                             -        -',
      '  │     → iterate',
      '  └ bump shared lib                                 Stopped     lib                     -       1h',
      '  add metrics                                       Working                           12k      <1m',
      '    ⚙ npm run e2e · make',
      '  alpha                                             Review                             8k       3h',
      '    ↳ x, y done',
      "    ↳ waiting for Bob's API change",
      '',
      '── infra ───────────────────────────────────────────────────────────────────────────────────────────',
      '  refactor the auth middleware so that it is long…  Permission  auth-mw               22k       9m',
      '    Bash: rm -rf node_modules',
      'session 42% · week 18%',
      '↑↓ select · Enter attach · e note · f wait for',
    ]);
  });
  it('どの行も端末の幅を超えず、行数は高さを超えない', () => {
    for (const [w, h] of [
      [40, 10],
      [20, 3],
      [76, 14],
      [120, 40],
    ]) {
      const lines = render({...example, width: w, height: h});
      expect(lines.length).toBe(h);
      for (const l of lines) expect(width(l)).toBeLessThanOrEqual(w);
      expect(stripAnsi(lines[0])).toContain('SES');
    }
  });
  it('端末の幅が足りないときは WHERE から詰める', () => {
    const lines = plain({...example, width: 80});
    expect(lines[2]).toBe('> fix-login                                      Review      fix-…  91k       5m');
    expect(lines[16]).toBe('  refactor the auth middleware so that it is l…  Permission  auth…  22k       9m');
  });
  it('収まらないときは選んだ行が見えるように窓を動かし、通し番号を出す(24)', () => {
    const rows = Array.from({length: 30}, (_, i) => row(`s${i}`));
    const lines = plain({width: 60, height: 10, cursor: 's20', groups: [{title: 'app', rows}], keys: 'k'});
    expect(lines.some(l => l.startsWith('> s20'))).toBe(true);
    expect(lines).toContain('21/30');
    expect(lines[0]).toContain('SESSION');
    expect(lines.length).toBe(10);
  });
  it('メモの入力欄は行と注記の直下に出て、↳ メモの行を置き換える(15)', () => {
    const s: Screen = {
      width: 60,
      height: 10,
      cursor: 'a',
      groups: [{title: 'app', rows: [row('a', {note: '古いメモ', line: 'done!'}), row('b')]}],
      inline: {sid: 'a', lines: ['Note for a: 素材待ち█', 'Enter confirm · Esc cancel']},
    };
    expect(plain(s).slice(1, 7)).toEqual([
      '── app ─────────────────────────────────────────────────────',
      '> a        Review           -        -',
      '    done!',
      '    Note for a: 素材待ち█',
      '    Enter confirm · Esc cancel',
      '  b        Review           -        -',
    ]);
  });
  it('入力欄とメニューは一覧のすぐ下に1行空けて出し、知らせはその下、Usage とキーは最下部', () => {
    const s: Screen = {
      width: 50,
      height: 12,
      cursor: 'a',
      groups: [{title: 'app', rows: [row('a')]}],
      panel: ['a waits for: █', '> New session'],
      notice: ['Deleted old.'],
      usage: 'session 1%',
      keys: '',
    };
    expect(plain(s)).toEqual([
      '  SESSION  STATUS  WHERE  CTX  WAITING',
      '── app ───────────────────────────────────────────',
      '> a        Review           -        -',
      '',
      'a waits for: █',
      '> New session',
      '',
      'Deleted old.',
      '',
      '',
      'session 1%',
      '',
    ]);
  });
  it('行が1件もないときはメッセージを出す(10)', () => {
    const lines = plain({width: 40, height: 5, groups: [], message: 'No sessions.', keys: 'k'});
    expect(lines).toEqual(['No sessions.', '', '', '', 'k']);
  });
  it('待機時間と CTX の表記', () => {
    expect(formatWaiting(undefined)).toBe('-');
    expect(formatWaiting(30_000)).toBe('<1m');
    expect(formatWaiting(5 * 60_000)).toBe('5m');
    expect(formatWaiting(2 * 3600_000)).toBe('2h');
    expect(formatWaiting(3 * 86400_000)).toBe('3d');
    expect(formatCtx(undefined)).toBe('-');
    expect(formatCtx(36_400)).toBe('36k');
    expect(formatCtx(1_234_567)).toBe('1.2M');
  });
  it('メニューは候補が多いと窓を出す', () => {
    const items = Array.from({length: 20}, (_, i) => ({label: `c${i}`}));
    const lines = menuLines({title: 'T', input: 'x', items, selected: 15, hint: 'h', maxItems: 5, width: 40}).map(
      stripAnsi,
    );
    expect(lines).toEqual(['T x█', '  c13', '  c14', '> c15', '  c16', '  c17', '16/20', 'h']);
  });
});
