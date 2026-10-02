// 画面の通し: attach と一覧に戻る経路、ステータス行、終了と端末を閉じたとき
// (シナリオ 5、6、16 の2つ目の起動、27、31、32、46、49、50、56)。

import {cpSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {Harness, ROOT, sleep} from './harness.js';

let h: Harness;
afterEach(() => h?.cleanup());

const attachAndBack = async () => {
  await h.keys('t', 'Enter');
  await h.waitFor('t', `FAKE CLAUDE SCREEN`);
  await h.keys('t', 'C-q', 'C-l');
  await h.waitFor('t', 'Last attached');
};

describe('attach', () => {
  it('6: Enter で attach し、空のプロンプトの ← で一覧に戻る。キー入力は二重に届かない', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'Enter');
    await h.waitFor('t', /FAKE CLAUDE SCREEN a000000[12]/);
    await h.type('t', 'hn');
    await sleep(300);
    expect(h.screen('t')).toContain('> hn');
    // h と n が一覧に届いていれば、保留の入力欄か新しいセッションの候補が出ている。
    await h.keys('t', 'BSpace', 'BSpace', 'Left');
    await h.waitFor('t', 'Last attached');
    expect(h.screen('t')).not.toMatch(/on hold|working directory/i);
    // ← で戻ったときは attach を畳む
    await sleep(300);
    expect(h.sessions().filter(s => /^a0/.test(s))).toEqual([]);
  });

  it('6: attach が 0 以外で終わると、子のメッセージを残し、キーを押すと一覧に戻る', async () => {
    h = new Harness();
    h.behave('attach', 'fail');
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'Enter');
    const s = await h.waitFor('t', 'Press any key to return to the list.');
    expect(s).toContain("Couldn't attach a0000001: fake failure");
    await sleep(500);
    expect(h.screen('t')).toContain('fake failure');
    await h.keys('t', 'x');
    await h.waitFor('t', 'Last attached');
  });

  it('27: ctrl+q ctrl+l は attach を残して戻り、次の Enter はすぐ元の画面。Ctrl+Z と /exit でも一覧に戻る', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await attachAndBack();
    expect(h.sessions()).toContain('a0000001');
    const before = h.calls().filter(c => c.startsWith('attach')).length;
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    expect(h.calls().filter(c => c.startsWith('attach')).length).toBe(before);
    await h.keys('t', 'C-z');
    await h.waitFor('t', 'Last attached');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.type('t', '/exit');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'Last attached');
    // ctrl+q の ほかの組み合わせは claude の画面では何もしない
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.keys('t', 'C-q', 'l');
    await sleep(400);
    expect(h.screen('t')).toContain('FAKE CLAUDE SCREEN');
    expect(h.screen('t')).not.toMatch(/> l/);
  });

  it('49: claude の画面の下に、概要の行とキーの説明が出る', async () => {
    h = new Harness();
    const cfgProj = join(h.cfg, 'projects', 'p');
    mkdirSync(cfgProj, {recursive: true});
    const row = h.row(1, {name: 'alpha'});
    writeFileSync(
      join(cfgProj, `${row.sessionId}.jsonl`),
      `${JSON.stringify({type: 'user', timestamp: new Date().toISOString(), message: {content: 'fix the login bug\nplease'}})}\n`,
    );
    h.setAgents([row, h.row(2, {name: 'beta'})]);
    h.open('t', [], {cols: 160});
    await h.waitFor('t', 'alpha');
    await h.select('t', 'alpha');
    await h.keys('t', 'Enter');
    const s = await h.waitFor('t', 'alpha · fix the login bug');
    const lines = s.replace(/\n$/, '').split('\n');
    expect(lines.at(-1)).toMatch(/\^Q\^L back · \^Q\^J next · \^Q\^W workbench · \^Q\^E external/);
    expect(lines.at(-2)).toMatch(/^alpha · fix the login bug/);
    await h.keys('t', 'C-q', 'C-l');
    await h.waitFor('t', 'Last attached');
    expect(h.screen('t')).not.toContain('^Q^J next');
  });

  it('56、5: ctrl+q ctrl+j で一覧を経由せずに Up next の先頭へ移る。戻ると移った先が Last attached', async () => {
    h = new Harness();
    h.setAgents([
      h.row(1, {name: 'alpha', state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'}),
      h.row(2, {name: 'beta', state: 'blocked', status: 'waiting', waitingFor: 'input needed'}),
      h.row(3, {name: 'gamma'}),
    ]);
    h.open('t', [], {cols: 140});
    await h.waitFor('t', 'gamma');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000001');
    await h.keys('t', 'C-q', 'C-j');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000002');
    await h.waitFor('t', /^beta/m);
    await h.keys('t', 'C-q', 'C-j');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000001');
    await h.keys('t', 'C-q', 'C-l');
    const s = await h.waitFor('t', 'Last attached');
    const lines = s.split('\n');
    const at = (n: string) => lines.findIndex(l => new RegExp(`^[> ] ${n} `).test(l));
    expect(at('alpha')).toBeLessThan(lines.findIndex(l => l.trim() === 'Up next'));
    expect(at('beta')).toBeGreaterThan(lines.findIndex(l => l.trim() === 'Up next'));
    expect(h.selected('t')).toMatch(/^> alpha/);
    await h.keys('t', 'Down');
    expect(h.selected('t')).toMatch(/^> beta/);
  });

  it('56: Up next が空なら移らず、No other session in Up next. が出る', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t', [], {cols: 140});
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.keys('t', 'C-q', 'C-j');
    await h.waitFor('t', 'No other session in Up next.');
    expect(h.screen('t')).toContain('FAKE CLAUDE SCREEN');
  });
});

describe('終了と、端末のウィンドウを閉じたとき', () => {
  it('31: 作業台で何も動いていなければ確認せずに終了し、何も残らない', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await attachAndBack();
    await h.keys('t', 'q');
    await h.waitFor('t', /\[exit 0\]/);
    expect(h.sessions()).toEqual([]);
  });

  it('31: 作業台で何か動いていれば英語の確認が出て、N なら閉じない、y なら閉じる', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'w');
    await h.waitFor('t', 'Workbench created.');
    h.tmux('send-keys', '-t', '=sh-a0000001:', 'sleep 1001', 'Enter');
    await sleep(800);
    await h.keys('t', 'q');
    await h.waitFor('t', /Quit and stop 1 running command\? alpha: sleep 1001 \[y\/N\]/);
    await h.keys('t', 'n');
    await h.waitGone('t', 'Quit and stop');
    expect(h.sessions()).toContain('sh-a0000001');
    await h.keys('t', 'q');
    await h.waitFor('t', 'Quit and stop');
    await h.keys('t', 'y');
    await h.waitFor('t', /\[exit 0\]/);
    expect(h.sessions()).toEqual([]);
  });

  it('32、16: 端末を閉じても終了せず、起動し直すと見ていたセッションが Last attached に出る。別の端末で起動すると一覧が移る', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta'})]);
    h.open('t');
    await h.waitFor('t', 'beta');
    await h.select('t', 'beta');
    await h.keys('t', 'h');
    await h.type('t', 'later');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'On hold');
    await h.select('t', 'alpha');
    await h.keys('t', 'w');
    await h.waitFor('t', 'Workbench created.');
    h.tmux('send-keys', '-t', '=sh-a0000001:', 'sleep 1002', 'Enter');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000001');
    h.closeTerminal('t');
    await sleep(800);
    expect(h.sessions()).toContain('list');
    h.open('t2');
    const s = await h.waitFor('t2', 'Last attached');
    expect(h.selected('t2')).toMatch(/^> alpha/);
    expect(s).toContain('↳ later');
    expect(s).toContain('⚙ sleep 1002');
    // 別の端末で起動すると、一覧は新しいほうに移り、前の端末はシェルに戻る
    h.open('t3');
    await h.waitFor('t3', 'alpha');
    await h.waitFor('t2', /\[exit 0\]|\[detached/);
  });

  it('46: 一覧のプロセスが異常終了したあとに起動すると、動いているコマンドを引き継ぐかを聞く', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta'})]);
    h.open('t');
    await h.waitFor('t', 'beta');
    await h.select('t', 'alpha');
    await h.keys('t', 'w');
    await h.waitFor('t', 'Workbench created.');
    await h.select('t', 'beta');
    await h.keys('t', 'w');
    await h.waitFor('t', 'Workbench created.');
    h.tmux('send-keys', '-t', '=sh-a0000001:', 'sleep 1003', 'Enter');
    await sleep(800);
    process.kill(h.listPid(), 'SIGKILL');
    await h.waitFor('t', /\[exit|detached/);
    h.open('t2');
    await h.waitFor(
      't2',
      /1 command is still running from a previous whatnext: alpha: sleep 1003\. Keep them\? \[Y\/n\]/,
    );
    expect(h.sessions()).not.toContain('sh-a0000002');
    await h.keys('t2', 'Enter');
    await h.waitGone('t2', 'Keep them?');
    expect(h.sessions()).toContain('sh-a0000001');
    await h.waitFor('t2', '⚙ sleep 1003');
  });

  it('46: 引き継ぐかに n と答えると止まる', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'w');
    await h.waitFor('t', 'Workbench created.');
    h.tmux('send-keys', '-t', '=sh-a0000001:', 'sleep 1004', 'Enter');
    await sleep(800);
    process.kill(h.listPid(), 'SIGKILL');
    await h.waitFor('t', /\[exit|detached/);
    h.open('t2');
    await h.waitFor('t2', 'Keep them?');
    await h.keys('t2', 'n');
    await h.waitGone('t2', 'Keep them?');
    await sleep(300);
    expect(h.sessions()).not.toContain('sh-a0000001');
  });

  it('50: 版の違う whatnext を起動すると、動いている一覧につながり、そのことが示される', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    const running = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    const other = join(h.root, 'other');
    mkdirSync(other);
    cpSync(join(ROOT, 'dist'), join(other, 'dist'), {recursive: true});
    cpSync(join(ROOT, 'node_modules'), join(other, 'node_modules'), {recursive: true, dereference: false});
    writeFileSync(join(other, 'package.json'), JSON.stringify({version: '9.9.9', type: 'module'}));
    // 別の場所の版で起動する
    const cmd = `node ${join(other, 'dist', 'cli.js')}`;
    h.open('t2', [], {env: {WN_CLI_OVERRIDE: cmd}});
    await h.waitFor('t2', 'alpha');
    h.closeTerminal('t2');
    const {spawnSync} = await import('node:child_process');
    spawnSync(
      'tmux',
      [
        '-L',
        h.outer,
        'new-session',
        '-d',
        '-s',
        't3',
        '-x',
        '120',
        '-y',
        '30',
        `env ${Object.entries(h.env())
          .map(([k, v]) => `${k}='${v}'`)
          .join(' ')} ${cmd}; sleep 100000`,
      ],
      {env: {...process.env, TMUX: ''}},
    );
    await h.waitFor('t3', `whatnext ${running} is still running. Quit it to start 9.9.9.`);
  });
});
