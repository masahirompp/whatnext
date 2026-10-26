import {cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {bg, CLI, Harness, REPO, sleep} from './harness.js';

// 起動時と全体、Usage、更新(PRODUCT.md「全体」「更新」「Usage の表示」)。

let h: Harness;
afterEach(() => h?.cleanup());

describe('起動時と全体', () => {
  it('42: 知らないオプションは使い方を出して終了コード 2。--help は先頭のときだけ', async () => {
    h = new Harness();
    h.port = 15999;
    h.open('a', `${h.envLine()} node ${CLI} --nope`);
    await h.waitFor(/whatnext: unknown option --nope\nUsage: whatnext[\s\S]*\[exit 2\]/, 8000, 'a');
    h.open('b', `${h.envLine()} node ${CLI} workbench --help`);
    await h.waitFor(/unknown option --help[\s\S]*\[exit 2\]/, 8000, 'b');
    h.open('c', `${h.envLine()} node ${CLI} x --help`);
    await h.waitFor(/unknown option x[\s\S]*\[exit 2\]/, 8000, 'c');
    h.open('d', `${h.envLine()} node ${CLI} --help x`);
    await h.waitFor(/Usage: whatnext[\s\S]*\[exit 0\]/, 8000, 'd');
  });

  it('whatnext の中のシェルで whatnext を起動すると断る', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    await h.start();
    await h.keys('w');
    await h.waitFor(/Workbench created/);
    h.inner('send-keys', '-t', '=sh-a0000000:', `node ${CLI}; echo "[exit $?]"`, 'Enter');
    await sleep(1500);
    const out = h.inner('capture-pane', '-p', '-J', '-t', '=sh-a0000000:');
    expect(out).toMatch(
      /whatnext: this shell runs inside whatnext\. Run "whatnext" in another split or window of your terminal\./,
    );
    expect(out).toMatch(/\[exit 1\]/);
  });

  it('29: tmux がないと英語で示して終了する', async () => {
    h = new Harness();
    h.port = 15998;
    const bin = join(h.dir, 'notmux');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    h.open(
      'a',
      `env -u TMUX WHATNEXT_ROLE= WHATNEXT_TMUX_SOCKET=${h.socket} WHATNEXT_PORT=15998 PATH=${bin} node ${CLI}`,
    );
    await h.waitFor(/whatnext: tmux is not installed\.[\s\S]*\[exit 1\]/, 8000, 'a');
  });

  it('50: 版の違う whatnext を起動すると、動いている一覧につながり、そのことが出る', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    await h.start();
    // 版だけを変えたものを、リポジトリの中の一時の場所に置く(パッケージはリポジトリの node_modules から引く)
    const other = join(REPO, 'test', 'e2e', '.tmp', h.socket);
    mkdirSync(other, {recursive: true});
    cpSync(join(REPO, 'dist'), join(other, 'dist'), {recursive: true});
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    writeFileSync(join(other, 'package.json'), JSON.stringify({...pkg, version: '9.9.9'}));
    h.open('second', `${h.envLine()} node ${join(other, 'dist', 'src', 'cli.js')}`);
    await h.waitFor(
      new RegExp(`whatnext ${pkg.version.replace(/\./g, '\\.')} is still running\\. Quit it to start 9\\.9\\.9\\.`),
      10000,
      'second',
    );
    await h.keysTo('second', 'q');
    await h.waitFor(/\[exit 0\]/, 8000, 'second');
    h.open('third', `${h.envLine()} node ${join(other, 'dist', 'src', 'cli.js')}`);
    await h.waitFor(/SESSION/, 10000, 'third');
    expect(h.inner('show', '-gv', '@wn_version').trim()).toBe('9.9.9');
    expect(h.screen('third')).not.toMatch(/is still running/);
  });
});

describe('更新と Usage', () => {
  it('2・13・38: 更新中は refreshing...、更新キーで Refreshed.。Usage は戻ったときに取り直すが 60 秒以内なら取り直さない。60 秒で自動で更新する', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'}), bg('b', {name: 'beta', state: 'working', status: 'busy'})]);
    await h.start();
    await h.waitFor(/session 42% \(resets 2:09pm\) · week \(all models\) 25% \(resets Sep 29 9:59am\)/);
    expect(h.lines().at(-2)).toMatch(/^session 42%/);
    expect(h.file('usage.count')).toBe('1');
    // 更新キー
    h.conf({agentsDelay: 1500});
    await h.keys('r');
    await h.waitFor(/refreshing\.\.\./);
    await h.waitFor(/Refreshed\./);
    // 60 秒以内に attach から戻っても取り直さない
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    await h.keys('C-q', 'C-l');
    await h.waitFor(/^> alpha/m);
    await sleep(2500);
    expect(h.file('usage.count')).toBe('1');
    // 60 秒たつと自動で更新し、戻ると取り直す
    h.conf({});
    h.update('beta', {state: 'done', status: 'idle'});
    // 更新と更新の間は並びも段も変わらない
    await sleep(3000);
    expect(h.screen()).toMatch(/beta +Working/);
    await h.waitFor(/beta +Review/, 75000);
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    await h.keys('C-q', 'C-l');
    await h.waitFor(() => h.file('usage.count') === '2', 5000);
  }, 120000);

  it('13: Usage を一度も取れていないときは出さず、一覧はふだんどおり', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    h.conf({usageFail: true});
    await h.start();
    await sleep(1500);
    expect(h.screen()).not.toMatch(/session \d+%/);
    expect(h.screen()).toMatch(/alpha/);
  });
});
