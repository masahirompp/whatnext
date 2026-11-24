import {describe, expect, it} from 'vitest';
import {stripAnsi, width} from '../../lib/text/text.js';
import {DIGEST_KEYS_HELP, LIST_KEYS_HELP} from '../../src/ops/keys.js';
import {formatAge, formatCtx, keyLines, menuLines, render} from '../../src/screen/screen.js';
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
          age: 5 * 60000,
          hasChildren: true,
          line: '変更点は3つです。',
        }),
        row('review fix-login', {
          status: 'Working',
          tone: 'working',
          where: {branch: 'fix-login', worktree: true},
          ctx: 40000,
          age: 2 * 60000,
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
        row('bump shared lib', {status: 'Stopped', tone: 'stopped', where: {repo: 'lib'}, age: 3600000, depth: 1}),
        row('add metrics', {
          status: 'Working',
          tone: 'working',
          ctx: 12000,
          age: 10000,
          running: ['npm run e2e', 'make'],
        }),
        row('alpha', {ctx: 8000, age: 3 * 3600000, note: "waiting for Bob's API change"}),
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
          age: 9 * 60000,
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
      '  SESSION                                           STATUS      WHERE                 CTX      AGE',
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
      "    ↳ waiting for Bob's API change",
      '',
      '── infra ───────────────────────────────────────────────────────────────────────────────────────────',
      '  refactor the auth middleware so that it is long…  Permission  auth-mw               22k       9m',
      '    Bash: rm -rf node_modules',
      '',
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
    expect(lines[15]).toBe('  refactor the auth middleware so that it is l…  Permission  auth…  22k       9m');
  });
  it('収まらないときは選んだ行が見えるように窓を動かし、通し番号を出す(24)', () => {
    const rows = Array.from({length: 30}, (_, i) => row(`s${i}`));
    const lines = plain({width: 60, height: 10, cursor: 's20', groups: [{title: 'app', rows}], keys: 'k'});
    expect(lines.some(l => l.startsWith('> s20'))).toBe(true);
    expect(lines).toContain('21/30');
    expect(lines[0]).toContain('SESSION');
    expect(lines.length).toBe(10);
  });
  it('通し番号に起動された行を数えず、選んだ行のすぐ下に続く起動された行も窓に入れる(24)', () => {
    const rows = [
      ...Array.from({length: 10}, (_, i) => row(`s${i}`)),
      row('p'),
      ...Array.from({length: 4}, (_, i) => row(`w${i}`, {marker: 'sub'})),
    ];
    const lines = plain({width: 60, height: 10, cursor: 'p', groups: [{title: 'app', rows}], keys: 'k'});
    expect(lines).toContain('11/11');
    expect(lines.some(l => l.startsWith('> p'))).toBe(true);
    expect(lines.some(l => l.startsWith('  w3 (sub)'))).toBe(true);
    // 最初の選べる行の上にある起動された行と見出しも窓に入れる
    const head = [
      ...Array.from({length: 4}, (_, i) => row(`w${i}`, {marker: 'sub'})),
      ...Array.from({length: 10}, (_, i) => row(`s${i}`)),
    ];
    const top = plain({width: 60, height: 10, cursor: 's0', groups: [{title: 'app', rows: head}], keys: 'k'});
    expect(top[1]).toMatch(/^── app/);
    expect(top).toContain('1/10');
  });
  it('続く起動された行が窓に収まらないときも、選んだ行とメモの入力欄を見せる', () => {
    const rows = [row('s0'), row('p'), ...Array.from({length: 12}, (_, i) => row(`w${i}`, {marker: 'sub'}))];
    const lines = plain({
      width: 60,
      height: 10,
      cursor: 'p',
      inline: {sid: 'p', lines: ['Note for p: x█']},
      groups: [{title: 'app', rows}],
      keys: 'k',
    });
    expect(lines.some(l => l.startsWith('> p'))).toBe(true);
    expect(lines.some(l => l.includes('Note for p: x'))).toBe(true);
  });
  it('区切りの頭の起動された行が窓に収まらないときも、選んだ行を見せる', () => {
    const rows = [...Array.from({length: 12}, (_, i) => row(`w${i}`, {marker: 'sub'})), row('p'), row('q')];
    const lines = plain({width: 60, height: 10, cursor: 'p', groups: [{title: 'app', rows}], keys: 'k'});
    expect(lines.some(l => l.startsWith('> p'))).toBe(true);
    expect(lines).toContain('1/2');
  });
  it('続く起動された行は区切りを越えて数えない', () => {
    const a = [...Array.from({length: 6}, (_, i) => row(`a${i}`)), row('p')];
    const b = [...Array.from({length: 8}, (_, i) => row(`w${i}`, {marker: 'sub'})), row('q')];
    const lines = plain({
      width: 60,
      height: 10,
      cursor: 'p',
      groups: [
        {title: 'a', rows: a},
        {title: 'b', rows: b},
      ],
      keys: 'k',
    });
    // p を窓の中ほどに置く(b の起動された行の側へ寄せない)
    const i = lines.findIndex(l => l.startsWith('> p'));
    expect(i).toBeGreaterThan(1);
    expect(i).toBeLessThan(7);
    expect(lines.some(l => l.startsWith('  a5'))).toBe(true);
  });
  it('起動された行だけの区切りは、直前の区切りの最後の選べる行と一緒に見せる', () => {
    const a = Array.from({length: 8}, (_, i) => row(`a${i}`));
    const b = Array.from({length: 3}, (_, i) => row(`w${i}`, {marker: 'sub'}));
    const c = Array.from({length: 8}, (_, i) => row(`c${i}`));
    const groups = [
      {title: 'a', rows: a},
      {title: 'b', rows: b},
      {title: 'c', rows: c},
    ];
    const lines = plain({width: 60, height: 12, cursor: 'a7', groups, keys: 'k'});
    expect(lines.some(l => l.startsWith('> a7'))).toBe(true);
    expect(lines.some(l => l.startsWith('  w2 (sub)'))).toBe(true);
    // 先頭の区切りが起動された行だけなら、次の区切りの最初の選べる行と一緒に見せる
    const head = plain({width: 60, height: 12, cursor: 'c0', groups: [groups[1], groups[2], groups[0]], keys: 'k'});
    expect(head[1]).toMatch(/^── b/);
    expect(head.some(l => l.startsWith('> c0'))).toBe(true);
  });
  it('頭と下の起動された行が全部は収まらないとき、下を優先して余りで頭も見せる', () => {
    const rows = [
      row('h0', {marker: 'sub'}),
      row('p'),
      ...Array.from({length: 5}, (_, i) => row(`w${i}`, {marker: 'sub'})),
    ];
    const lines = plain({
      width: 60,
      height: 10,
      cursor: 'p',
      groups: [
        {title: 'app', rows},
        {title: 'z', rows: [row('z0')]},
      ],
      keys: 'k',
    });
    expect(lines.some(l => l.startsWith('  h0 (sub)'))).toBe(true);
    expect(lines.some(l => l.startsWith('  w4 (sub)'))).toBe(true);
  });
  it('選べる行がないときは通し番号を出さない', () => {
    const rows = Array.from({length: 12}, (_, i) => row(`w${i}`, {marker: 'sub'}));
    const lines = plain({width: 60, height: 8, cursor: undefined, groups: [{title: 'app', rows}], keys: 'k'});
    expect(lines.some(l => /^\d+\/\d+$/.test(l))).toBe(false);
    expect(lines.some(l => l.startsWith('  w0 (sub)'))).toBe(true);
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
      '  SESSION  STATUS  WHERE  CTX      AGE',
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
  it('作ってからの時間と CTX の表記', () => {
    expect(formatAge(undefined)).toBe('-');
    expect(formatAge(30_000)).toBe('<1m');
    expect(formatAge(5 * 60_000)).toBe('5m');
    expect(formatAge(2 * 3600_000)).toBe('2h');
    expect(formatAge(3 * 86400_000)).toBe('3d');
    expect(formatCtx(undefined)).toBe('-');
    expect(formatCtx(36_400)).toBe('36k');
    expect(formatCtx(1_234_567)).toBe('1.2M');
  });
  it('外から来た文字列の制御文字を除いて描く', () => {
    const esc = String.fromCharCode(27);
    const s: Screen = {
      width: 60,
      height: 6,
      cursor: 'a',
      groups: [
        {
          title: 'app',
          rows: [row('a', {name: `bad${esc}[31mname`, line: `x${esc}]2;title${String.fromCharCode(7)}y`})],
        },
      ],
    };
    const lines = render(s);
    expect(lines.join('\n')).not.toContain(`${esc}]2;`);
    expect(lines.map(stripAnsi).join('\n')).toContain('bad[31mname');
  });
  it('キーの説明は、幅に収まれば1行で、収まらないときだけ区切りで折り返す', () => {
    expect(keyLines(DIGEST_KEYS_HELP, 130)).toEqual([DIGEST_KEYS_HELP]);
    expect(keyLines(LIST_KEYS_HELP, 120)).toEqual([LIST_KEYS_HELP]);
    expect(keyLines(DIGEST_KEYS_HELP, 129)).toEqual([
      '↑↓ select · Enter attach · n new · ^X stop/delete · e note · f wait for · w/t workbench · v VS Code · o links · r refresh',
      'q quit',
    ]);
    expect(keyLines(DIGEST_KEYS_HELP, 100)).toEqual([
      '↑↓ select · Enter attach · n new · ^X stop/delete · e note · f wait for · w/t workbench · v VS Code',
      'o links · r refresh · q quit',
    ]);
    expect(keyLines(LIST_KEYS_HELP, 40)).toEqual([
      '↑↓ select · Enter attach · n new',
      '^X stop/delete · e note · f wait for',
      'w/t workbench · v VS Code · r refresh',
      'q quit',
    ]);
    // 文言は削らない。どの幅でも、行をつなぎ直すと元の説明に戻り、行は幅を超えない
    for (const help of [LIST_KEYS_HELP, DIGEST_KEYS_HELP]) {
      for (let w = 14; w <= 140; w++) {
        const lines = keyLines(help, w);
        expect(lines.join(' · ')).toBe(help);
        for (const l of lines) expect(width(l)).toBeLessThanOrEqual(w);
      }
    }
  });
  it('キーの説明の1つの項目が幅を超えるときは、その行を切る。行数の上限を超える分は、最後の行に続けて切る', () => {
    expect(keyLines('↑↓ select · ^X stop/delete · q quit', 10)).toEqual(['↑↓ select', '^X stop/d…', 'q quit']);
    expect(keyLines(LIST_KEYS_HELP, 40, 2)).toEqual([
      '↑↓ select · Enter attach · n new',
      '^X stop/delete · e note · f wait for · …',
    ]);
    expect(keyLines(LIST_KEYS_HELP, 40, 1)).toEqual(['↑↓ select · Enter attach · n new · ^X s…']);
    expect(keyLines('', 40)).toEqual(['']);
  });
  it('折り返したキーの説明の分だけ一覧の窓が減り、選んだ行は見えたままになる', () => {
    const rows = Array.from({length: 30}, (_, i) => row(`s${i}`));
    const s: Screen = {
      width: 60,
      height: 12,
      cursor: 's29',
      groups: [{title: 'app', rows}],
      usage: 'session 42%',
      keys: LIST_KEYS_HELP,
    };
    const lines = plain(s);
    expect(lines.length).toBe(12);
    expect(lines[0]).toMatch(/SESSION/);
    expect(lines.some(l => l.startsWith('> s29'))).toBe(true);
    expect(lines.slice(-3)).toEqual([
      'session 42%',
      '↑↓ select · Enter attach · n new · ^X stop/delete · e note',
      'f wait for · w/t workbench · v VS Code · r refresh · q quit',
    ]);
    expect(lines[8]).toBe('30/30');
  });
  it('端末の高さが小さいときは、ヘッダと一覧の1行を残して、キーの説明の行数を抑える', () => {
    const base: Screen = {
      width: 40,
      height: 5,
      cursor: 'a',
      groups: [{title: 'app', rows: [row('a')]}],
      keys: LIST_KEYS_HELP,
    };
    const lines = plain(base);
    expect(lines.length).toBe(5);
    expect(lines[0]).toMatch(/SESSION/);
    expect(lines.slice(2)).toEqual([
      '↑↓ select · Enter attach · n new',
      '^X stop/delete · e note · f wait for',
      'w/t workbench · v VS Code · r refresh ·…',
    ]);
    for (let h = 1; h <= 8; h++) {
      const out = render({...base, height: h, usage: 'session 42%'});
      expect(out.length).toBe(h);
      for (const l of out) expect(width(l)).toBeLessThanOrEqual(40);
    }
  });
  it('高さが足りないときは、キーの説明の行数を減らして、知らせを先に見せる', () => {
    const base = (height: number, notice = ['Deleted alpha.']): Screen => ({
      width: 60,
      height,
      cursor: 'a',
      groups: [{title: 'app', rows: [row('a')]}],
      usage: 'session 42%',
      keys: DIGEST_KEYS_HELP,
      notice,
    });
    const head = [
      '  SESSION  STATUS  WHERE  CTX      AGE',
      `── app ${'─'.repeat(53)}`,
      '> a        Review           -        -',
    ];
    const first = '↑↓ select · Enter attach · n new · ^X stop/delete · e note';
    // 収まる高さでは、折り返しの形を変えない
    expect(plain(base(9))).toEqual([
      ...head,
      '',
      'Deleted alpha.',
      'session 42%',
      first,
      'f wait for · w/t workbench · v VS Code · o links · r refresh',
      'q quit',
    ]);
    // 1行足りなければ1行減らし、残りは最後の行に続けて切る
    expect(plain(base(8))).toEqual([
      ...head,
      '',
      'Deleted alpha.',
      'session 42%',
      first,
      'f wait for · w/t workbench · v VS Code · o links · r refres…',
    ]);
    expect(plain(base(9, ['refreshing...', 'Deleted alpha.'])).slice(3, 7)).toEqual([
      '',
      'refreshing...',
      'Deleted alpha.',
      'session 42%',
    ]);
    // 折り返す前(最下部が Usage とキーの説明1行)に知らせが出ていた高さでは、出る
    expect(plain(base(7))).toEqual([...head, '', 'Deleted alpha.', 'session 42%', `${first} …`]);
    // 1行にしても収まらない高さでは、1行のまま下から削る(折り返す前と同じ)
    expect(plain(base(6)).slice(-2)).toEqual(['session 42%', `${first} …`]);
  });
  it('メニューや入力欄を開いている間は、キーの説明の行数だけ空けて、Usage の位置を変えない', () => {
    const base: Screen = {
      width: 100,
      height: 10,
      cursor: 'a',
      groups: [{title: 'app', rows: [row('a')]}],
      usage: 'session 42%',
      keys: DIGEST_KEYS_HELP,
    };
    const open = plain(base);
    const hidden = plain({...base, keysHidden: true, panel: ['Note: █'], notice: ['Refreshed.']});
    expect(open.slice(-3)).toEqual([
      'session 42%',
      '↑↓ select · Enter attach · n new · ^X stop/delete · e note · f wait for · w/t workbench · v VS Code',
      'o links · r refresh · q quit',
    ]);
    expect(hidden.slice(3)).toEqual(['', 'Note: █', '', 'Refreshed.', 'session 42%', '', '']);
  });
  it('高さが足りないときは、空けた行を1行まで減らして、メニューの中身(候補、件数、案内)を先に見せる', () => {
    const menu = (width: number, height: number) =>
      menuLines({
        title: 'New session in:',
        input: '',
        items: ['~/a', '~/b', '~/c', '~/d', '~/e', 'Other...'].map(label => ({label})),
        selected: 0,
        hint: 'Type to filter · Enter start · Esc close',
        // app.ts の panel() と同じ
        maxItems: Math.max(3, Math.floor(height / 2) - 4),
        width,
      });
    const base = (width: number, height: number): Screen => ({
      width,
      height,
      cursor: 'a',
      groups: [{title: 'app', rows: [row('a'), row('b'), row('c')]}],
      usage: 'session 42%',
      keys: DIGEST_KEYS_HELP,
      keysHidden: true,
      panel: menu(width, height),
    });
    for (const w of [80, 60]) {
      expect(plain(base(w, 12))).toEqual([
        '  SESSION  STATUS  WHERE  CTX      AGE',
        '> a        Review           -        -',
        '1/3',
        '',
        'New session in: █',
        '> ~/a',
        '  ~/b',
        '  ~/c',
        '1/6',
        'Type to filter · Enter start · Esc close',
        'session 42%',
        '',
      ]);
    }
    // 1行ぶん高ければ、空ける行を1行だけ戻す。収まる高さでは、折り返した行数(60 桁では3行)を空けたまま
    const hint = 'Type to filter · Enter start · Esc close';
    expect(plain(base(60, 13)).slice(-4)).toEqual([hint, 'session 42%', '', '']);
    expect(plain(base(60, 14)).slice(-5)).toEqual([hint, 'session 42%', '', '', '']);
    expect(plain(base(60, 20)).slice(-4)).toEqual(['session 42%', '', '', '']);
  });
  it('高さが足りないときは、確認の問いとメモの入力欄も、空けた行より先に見せる', () => {
    const base: Screen = {
      width: 60,
      height: 6,
      cursor: 'a',
      groups: [{title: 'app', rows: [row('a'), row('b'), row('c')]}],
      usage: 'session 42%',
      keys: DIGEST_KEYS_HELP,
      keysHidden: true,
    };
    expect(plain({...base, height: 7, panel: ['Stop a? [y/N]']})).toEqual([
      '  SESSION  STATUS  WHERE  CTX      AGE',
      '> a        Review           -        -',
      '1/3',
      '',
      'Stop a? [y/N]',
      'session 42%',
      '',
    ]);
    expect(plain({...base, inline: {sid: 'a', lines: ['Note for a: █', 'Enter confirm']}})).toEqual([
      '  SESSION  STATUS  WHERE  CTX      AGE',
      '    Note for a: █',
      '    Enter confirm',
      '1/3',
      'session 42%',
      '',
    ]);
    // 空けた行を1行にしても収まらない高さでは、1行を残して下から削る(折り返す前と同じ形)
    expect(plain({...base, height: 5, panel: ['Stop a? [y/N]']})).toEqual([
      '  SESSION  STATUS  WHERE  CTX      AGE',
      '> a        Review           -        -',
      '1/3',
      'session 42%',
      '',
    ]);
  });
  it('右の欄があるときも、キーの説明は全幅で折り返し、右の欄はその上で止まる', () => {
    const lines = plain({
      width: 120,
      height: 10,
      cursor: 'a',
      groups: [{title: 'app', rows: [row('a')]}],
      usage: 'session 42%',
      keys: DIGEST_KEYS_HELP,
      side: {title: 'a', links: []},
    });
    expect(lines.length).toBe(10);
    expect(lines[6]).toMatch(/ │/);
    expect(lines.slice(-3)).toEqual([
      'session 42%',
      '↑↓ select · Enter attach · n new · ^X stop/delete · e note · f wait for · w/t workbench · v VS Code · o links',
      'r refresh · q quit',
    ]);
  });
  it('メニューは候補が多いと窓を出す', () => {
    const items = Array.from({length: 20}, (_, i) => ({label: `c${i}`}));
    const lines = menuLines({title: 'T', input: 'x', items, selected: 15, hint: 'h', maxItems: 5, width: 40}).map(
      stripAnsi,
    );
    expect(lines).toEqual(['T x█', '  c13', '  c14', '> c15', '  c16', '  c17', '16/20', 'h']);
  });
});
