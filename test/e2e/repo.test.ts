// 画面の通し: リポジトリのビュー(シナリオ 61、62、65、66)。

import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {Harness} from './harness.js';

let h: Harness;
afterEach(() => h?.cleanup());

/** `repo` のほかに、リポジトリ `infra` と、git でない場所 `scratch` を作る。 */
function places(): {infra: string; scratch: string} {
  const infra = join(h.root, 'infra');
  const scratch = join(h.root, 'scratch');
  mkdirSync(scratch, {recursive: true});
  execFileSync('git', ['init', '-q', '-b', 'main', infra]);
  return {infra, scratch};
}

const lineOf = (s: string, re: RegExp) => s.split('\n').findIndex(l => re.test(l));

describe('リポジトリのビュー', () => {
  it('61、62: g で区切りにまとまり、attach して戻った行が区切りの先頭に上がる。g でラダーのビューに戻る', async () => {
    h = new Harness();
    const {infra, scratch} = places();
    h.setAgents([
      h.row(1, {name: 'alpha'}),
      h.row(2, {name: 'beta', state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'}),
      h.row(3, {name: 'gamma', cwd: infra}),
      h.row(4, {name: 'delta', cwd: scratch}),
    ]);
    h.open('t', [], {cols: 140});
    await h.waitFor('t', 'delta');
    await h.keys('t', 'g');
    let s = await h.waitFor('t', 'g ladder view');
    // 区切りは見出しの順(infra、repo、scratch)。区切りの間は1行あく。
    expect(s).toMatch(/\n {2}infra\n[> ] gamma [^\n]*\n\n {2}repo\n/);
    expect(s).toMatch(/\n\n {2}scratch\n[> ] delta /);
    expect(s).not.toContain('Up next');
    // 同じリポジトリの行の WHERE にはリポジトリ名を出さない
    expect(s).toMatch(/alpha +Review +- +-/);
    // beta に attach して戻ると、beta が repo の区切りの先頭に上がり、カーソルが付く
    await h.select('t', 'beta');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000002');
    await h.keys('t', 'C-q', 'C-l');
    s = await h.waitFor('t', 'g ladder view');
    expect(s).not.toContain('Last attached');
    expect(h.selected('t')).toMatch(/^> beta/);
    const repoAt = lineOf(s, /^ {2}repo$/);
    expect(lineOf(s, /^[> ] beta /)).toBe(repoAt + 1);
    expect(lineOf(s, /^[> ] alpha /)).toBe(repoAt + 2);
    // ラダーのビューに戻しても、カーソルは同じセッションに付いていく
    await h.keys('t', 'g');
    s = await h.waitFor('t', 'g repo view');
    expect(s).toContain('Last attached');
    expect(h.selected('t')).toMatch(/^> beta/);
  });

  it('65、66: 保留の行は区切りに残ってカーソルも残る。終了して起動し直してもビューと並びが残る', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta'})]);
    h.open('t', [], {cols: 140});
    await h.waitFor('t', 'beta');
    await h.keys('t', 'g');
    await h.waitFor('t', 'g ladder view');
    // alpha に attach して戻る(alpha が先頭)
    await h.select('t', 'alpha');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000001');
    await h.keys('t', 'C-q', 'C-l');
    await h.waitFor('t', 'g ladder view');
    // beta を保留にしても、区切りに残り、カーソルは beta に残る
    await h.select('t', 'beta');
    await h.keys('t', 'h');
    await h.waitFor('t', 'Put beta on hold. Reason:');
    await h.type('t', 'later');
    await h.keys('t', 'Enter');
    let s = await h.waitFor('t', 'beta (on hold)');
    expect(s).toMatch(/beta \(on hold\)[^\n]*\n {4}↳ later/);
    expect(s).not.toContain('On hold\n');
    expect(h.selected('t')).toMatch(/^> beta/);
    expect(h.stateFile()).toMatchObject({version: 2, view: 'repo'});
    await h.keys('t', 'q');
    await h.waitFor('t', /\[exit 0\]/);
    // 起動し直すと、リポジトリのビューで開き、カーソルは最も新しく attach した alpha にある
    h.open('t', [], {cols: 140});
    s = await h.waitFor('t', /^> alpha/m);
    expect(s).toContain('g ladder view');
    expect(lineOf(s, /^[> ] alpha /)).toBeLessThan(lineOf(s, /^[> ] beta /));
  });
});
