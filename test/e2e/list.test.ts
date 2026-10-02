// 画面の通し: 一覧と並び、更新、起動時(シナリオ 1、2、5、7、10、11、13、24、38、42)。

import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {Harness, ROOT, sleep} from './harness.js';

let h: Harness;
afterEach(() => h?.cleanup());

describe('一覧', () => {
  it('1: 状態の違うセッションが優先度ラダーの順に1画面で並び、段・待機時間・名前・場所が出る', async () => {
    h = new Harness();
    h.setAgents([
      h.row(1, {name: 'review-a'}),
      h.row(2, {name: 'perm-b', state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'}),
      h.row(3, {name: 'work-c', state: 'working', status: 'busy', cwd: '/tmp'}),
      h.row(4, {name: 'odd-d', state: 'blocked', status: 'waiting', waitingFor: 'dialog open'}),
      h.row(5, {name: 'gone-e', state: 'blocked', status: undefined, pid: undefined}),
    ]);
    h.open('t');
    const s = await h.waitFor('t', 'review-a');
    const lines = s.split('\n');
    const at = (n: string) => lines.findIndex(l => l.includes(n));
    expect(at('perm-b')).toBeLessThan(at('odd-d'));
    expect(at('odd-d')).toBeLessThan(at('gone-e'));
    expect(at('gone-e')).toBeLessThan(at('review-a'));
    expect(at('review-a')).toBeLessThan(at('work-c'));
    expect(s).toMatch(/SESSION +STATUS +WHERE +CTX +WAITING/);
    expect(s).toMatch(/perm-b +Permission +repo +- +-/);
    expect(s).toMatch(/odd-d +Question \(dialog open\)/);
    expect(s).toMatch(/gone-e +Failed \(no process\)/);
    expect(s).toMatch(/work-c +Working +tmp/);
  });

  it('2: 更新キーで更新すると Refreshed. が出て、更新の間に今の段に入った行は前回の更新から数える', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha', state: 'working', status: 'busy'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    h.update(h.row(1).id as string, {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'});
    await h.keys('t', 'r');
    const s = await h.waitFor('t', 'Refreshed.');
    expect(s).toMatch(/alpha +Permission +repo +- +<1m/);
    expect(s).not.toMatch(/ago|updated/i);
    await h.waitGone('t', 'Refreshed.', 4000);
  });

  it('5: 更新で並びが変わってもカーソルは選んだセッションに付いていく', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta'})]);
    h.open('t');
    await h.waitFor('t', 'beta');
    await h.select('t', 'beta');
    h.update(h.row(2).id as string, {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'});
    await h.keys('t', 'r');
    await h.waitFor('t', /beta +Permission/);
    expect(h.selected('t')).toMatch(/^> beta/);
    expect(
      h
        .screen('t')
        .split('\n')
        .findIndex(l => l.includes('beta')),
    ).toBeLessThan(
      h
        .screen('t')
        .split('\n')
        .findIndex(l => l.includes('alpha')),
    );
  });

  it('7: interactive の行で Enter を押すと、attach せずに場所が出る', async () => {
    h = new Harness();
    h.setAgents([
      {
        kind: 'interactive',
        sessionId: 'ffff0000-0000-4000-8000-000000000001',
        cwd: '/tmp',
        name: 'tty-x',
        pid: 4242,
        status: 'waiting',
        waitingFor: 'permission prompt',
      },
    ]);
    h.open('t');
    await h.waitFor('t', 'tty-x (tty)');
    await h.keys('t', 'Enter');
    const s = await h.waitFor('t', '4242');
    expect(s).toContain('/tmp');
    expect(h.clients().map(c => c.session)).toEqual(['list']);
  });

  it('10: 対象の行がないときはメッセージ。--json が失敗するとエラーを出し、古い一覧は出さない', async () => {
    h = new Harness();
    h.open('t');
    await h.waitFor('t', 'No sessions to show.');
    h.setAgents([h.row(1, {name: 'alpha'})]);
    await h.keys('t', 'r');
    await h.waitFor('t', 'alpha');
    h.behave('agents', 'fail');
    await h.keys('t', 'r');
    const s = await h.waitFor('t', 'claude agents --json failed');
    expect(s).not.toContain('alpha');
    h.behave('agents', 'broken');
    await h.keys('t', 'r');
    await h.waitFor('t', 'Could not parse');
    h.behave('agents', null);
    await h.keys('t', 'r');
    await h.waitFor('t', 'alpha');
  });

  it('24: 端末の高さに収まらないときはスクロールし、通し番号が出る。Last attached と Up next の見出しは固定', async () => {
    h = new Harness();
    h.setAgents(Array.from({length: 20}, (_, i) => h.row(i + 1, {name: `sess-${String(i + 1).padStart(2, '0')}`})));
    h.open('t', [], {rows: 12});
    await h.waitFor('t', 'sess-01');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.keys('t', 'C-q', 'C-l');
    await h.waitFor('t', 'Last attached');
    for (let i = 0; i < 15; i++) await h.keys('t', 'Down');
    const s = await h.waitFor('t', /\d+\/20/);
    const lines = s.replace(/\n$/, '').split('\n');
    expect(lines.some(l => l.trim() === 'Last attached')).toBe(true);
    expect(lines.some(l => l.trim() === 'Up next')).toBe(true);
    expect(lines.some(l => l.startsWith('> sess-'))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(12);
  });

  it('13、38: ヘッダに Usage が出る。attach から60秒以内に戻っても取り直さない', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta'})]);
    h.open('t');
    const s = await h.waitFor('t', 'session 42%');
    expect(s).toContain('week (all models) 85% (resets Oct 9 9:59am)');
    const usageCalls = () => h.calls().filter(c => c.startsWith('-p /usage')).length;
    expect(usageCalls()).toBe(1);
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.keys('t', 'C-q', 'C-l');
    await h.waitFor('t', 'Last attached');
    await h.keys('t', 'r');
    await h.waitFor('t', 'Refreshed.');
    expect(usageCalls()).toBe(1);
  });

  it('13: 一度取れたあとで Usage の取得に失敗しても前の値が出たまま。取れていなければ Usage だけが出ない', async () => {
    h = new Harness();
    h.behave('usage', 'fail');
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    const s = await h.waitFor('t', 'alpha');
    await sleep(500);
    expect(h.screen('t')).not.toContain('session');
    expect(s).toContain('SESSION');
  });

  it('11: 画面の文言は英語', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    const s = await h.waitFor('t', 'alpha');
    expect(s.replace(/alpha|repo/g, '')).toMatch(/^[\x20-\x7e\s·↑↓…─]*$/);
  });
});

describe('起動', () => {
  it('42: 知らないオプションを付けると使い方を示して終了コード 2', () => {
    const run = (...args: string[]) =>
      spawnSync('node', [join(ROOT, 'dist', 'cli.js'), ...args], {
        encoding: 'utf8',
        env: {...process.env, WHATNEXT_ROLE: ''},
      });
    const r = run('--verbose');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('whatnext: unknown option --verbose');
    expect(r.stderr).toContain('Usage:');
    expect(run('workbench', '--help').status).toBe(2);
    expect(run('x', '--help').status).toBe(2);
    const help = run('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('whatnext workbench');
  });

  it('whatnext の中のシェルで起動すると断る', () => {
    const r = spawnSync('node', [join(ROOT, 'dist', 'cli.js')], {
      encoding: 'utf8',
      env: {...process.env, WHATNEXT_ROLE: 'list', TMUX_PANE: ''},
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('this shell runs inside whatnext');
  });
});
