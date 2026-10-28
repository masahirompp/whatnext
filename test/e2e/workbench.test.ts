import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';
import {bg, CLI, Harness, sid, sleep, tty} from './harness.js';

// 作業台と作業台の画面、終了と端末のウィンドウを閉じたとき(PRODUCT.md「作業台」「終了と、端末のウィンドウを閉じたとき」)。

let h: Harness;
afterEach(() => h?.cleanup());

const wbClient = () => h.clients().find(c => c.session.startsWith('sh-') || c.session === 'wbguide');

describe('作業台の画面', () => {
  it('25・57: 作業台がないことと場所が出て、Enter で作る。カーソルに追従し、カーソルを動かしただけでは作らない。attach にも追従する', async () => {
    h = new Harness();
    const app = h.repo('app');
    const lib = h.repo('lib');
    h.agents([
      bg('a', {cwd: app, name: 'alpha'}),
      bg('b', {cwd: lib, name: 'beta'}),
      tty('q', {cwd: lib, name: 'poke'}),
    ]);
    await h.start();
    await h.startWorkbench();
    await h.waitFor(/No workbench for alpha yet\.\nEnter: open a shell in .*app/, 5000, 'wb');
    expect(h.screen('wb')).toMatch(/workbench: alpha/);
    // 案内のセッションには分割とウィンドウのキーを出さず、セッション名だけを出す
    expect(h.lines('wb').at(-1)?.trimEnd()).toMatch(/workbench: alpha$/);
    await h.select('beta');
    await h.waitFor(/No workbench for beta yet/, 5000, 'wb');
    await h.select('poke');
    await h.waitFor(/poke is an interactive session\. It has no workbench\./, 5000, 'wb');
    expect(h.sessions().filter(s => s.startsWith('sh-'))).toEqual([]);
    await h.select('alpha');
    await h.waitFor(/No workbench for alpha yet/, 5000, 'wb');
    await h.keysTo('wb', 'Enter');
    await h.waitFor(() => wbClient()?.session === 'sh-a0000000', 5000);
    await h.type('echo wb-$((20+22))', 'wb');
    await h.keysTo('wb', 'Enter');
    await h.waitFor(/wb-42/, 5000, 'wb');
    // attach すると、作業台の画面もそのセッションの作業台に切り替わる
    await h.select('beta');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to b0000000/);
    await h.waitFor(/No workbench for beta yet/, 5000, 'wb');
    // claude の画面に打った文字は作業台に入らない
    await h.type('hello');
    expect(h.screen('wb')).not.toMatch(/hello/);
    expect(h.file('attach-input.log')).toMatch(/hello/);
    await h.keys('C-q', 'C-l');
    await h.waitFor(/^> beta/m);
  });

  it('26・59: 作業台の分割と動いているものは、セッションを移っても残る。2つ目の作業台の画面を開くと前のほうはシェルに戻る', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'}), bg('b', {name: 'beta'})]);
    await h.start();
    await h.startWorkbench();
    await h.waitFor(/No workbench for alpha/, 5000, 'wb');
    await h.keysTo('wb', 'Enter');
    await h.waitFor(() => wbClient()?.session === 'sh-a0000000', 5000);
    await h.keysTo('wb', 'C-q', '%');
    await sleep(500);
    expect(h.inner('list-panes', '-t', '=sh-a0000000:', '-F', '#{pane_id}').trim().split('\n').length).toBe(2);
    await h.type('sleep 1001', 'wb');
    await h.keysTo('wb', 'Enter');
    await h.keysTo('wb', 'C-q', 'Left');
    await h.type('sleep 1002', 'wb');
    await h.keysTo('wb', 'Enter');
    await sleep(500);
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to a0000000/);
    await h.keys('C-q', 'C-l');
    await h.select('beta');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to b0000000/);
    await h.waitFor(/No workbench for beta/, 5000, 'wb');
    await h.keys('C-q', 'C-l');
    await h.select('alpha');
    await h.keys('Enter');
    await h.waitFor(() => wbClient()?.session === 'sh-a0000000', 5000);
    expect(
      h.inner('list-panes', '-t', '=sh-a0000000:', '-F', '#{pane_current_command}').trim().split('\n').sort(),
    ).toEqual(['sleep', 'sleep']);
    // 2つ目の作業台の画面
    await h.startWorkbench('wb2');
    await h.waitFor(/\[exit 0\]/, 5000, 'wb');
    await h.waitFor(() => h.clients().some(c => c.session === 'sh-a0000000'), 5000);
    expect(h.clients().length).toBe(2);
    // whatnext の画面だけを閉じても、作業台の画面は最後の作業台を映したまま
    execFileSync('tmux', ['-L', h.outer, 'kill-session', '-t', '=main']);
    await sleep(800);
    expect(h.clients().map(c => c.session)).toEqual(['sh-a0000000']);
    await h.start();
    await h.select('beta');
    await h.waitFor(/No workbench for beta/, 5000, 'wb2');
  });

  it('59: whatnext が動いていないときに whatnext workbench を実行すると断る', async () => {
    h = new Harness();
    h.port = 14999;
    h.open('wb', `${h.envLine()} node ${CLI} workbench`);
    await h.waitFor(/whatnext is not running\. Start whatnext first\.\n\[exit 1\]/, 8000, 'wb');
  });

  it('28・49: claude のキーは claude に届く。作業台の Ctrl+Z はジョブ停止。最後のシェルを exit すると Workbench closed. と案内が出る', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    await h.start();
    await h.startWorkbench();
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    await h.keys('C-b', 'C-g');
    await sleep(300);
    expect(h.file('attach-input.log')).toMatch(/\\u0002/);
    expect(h.file('attach-input.log')).toMatch(/\\u0007/);
    // 作業台がないとき、claude の画面のステータス行の左は空
    await h.keysTo('wb', 'Enter');
    await h.waitFor(() => wbClient()?.session === 'sh-a0000000', 5000);
    await h.waitFor(/workbench: alpha {2}0:\S+\* {2}· \^Q% split │ · \^Q" split ─ · \^Qc window/, 5000, 'wb');
    await h.type('sleep 1003', 'wb');
    await h.keysTo('wb', 'Enter');
    await h.waitFor(/⚙ sleep 1003/, 10000);
    await h.keysTo('wb', 'C-z');
    await h.waitFor(/suspended|Stopped|停止/i, 5000, 'wb');
    await h.type('kill %1', 'wb');
    await h.keysTo('wb', 'Enter');
    await sleep(500);
    await h.type('exit', 'wb');
    await h.keysTo('wb', 'Enter');
    await h.waitFor(/Workbench closed\.\nNo workbench for alpha yet\./, 8000, 'wb');
    expect(h.sessions()).not.toContain('sh-a0000000');
    await sleep(1000);
    expect(h.sessions()).not.toContain('sh-a0000000');
    await h.keysTo('wb', 'Enter');
    await h.waitFor(() => wbClient()?.session === 'sh-a0000000', 5000);
    await h.waitFor(/⌂ workbench \(shell\)/, 10000);
    // 案内した ^Qc と ^Q" が効き、ウィンドウが2つでもキーはウィンドウの一覧のあとに続く
    await h.keysTo('wb', 'C-q', 'c');
    await h.waitFor(/workbench: alpha {2}0:\S+ 1:\S+\* {2}· \^Q% split │/, 5000, 'wb');
    await h.keysTo('wb', 'C-q', '"');
    // 上下に分かれるので、2つのペインの上端が違う
    const tops = () =>
      new Set(h.inner('list-panes', '-t', '=sh-a0000000:1', '-F', '#{pane_top}').trim().split('\n')).size;
    await h.waitFor(() => tops() === 2, 5000);
  });

  it('30: 作業台で動いているものが一覧に ⚙ で出て、終わると次の更新で消える', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    await h.start();
    await h.keys('w');
    await h.waitFor(/Workbench created\. Run "whatnext workbench" in a split to see it\./);
    h.inner('send-keys', '-t', '=sh-a0000000:', 'sleep 2 | cat', 'Enter');
    await sleep(500);
    await h.refresh();
    expect(h.screen()).toMatch(/^ {4}⚙ sleep 2 \| cat$/m);
    await sleep(2500);
    await h.refresh();
    expect(h.screen()).not.toMatch(/⚙/);
  });

  it('58・60: ctrl+q ctrl+w で作り、2回目は already exists。作業台の画面の ctrl+q ctrl+l、ctrl+q ctrl+v、ctrl+q c', async () => {
    h = new Harness();
    const app = h.repo('app');
    h.agents([bg('a', {cwd: app, name: 'alpha'})]);
    await h.start();
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    // worktree に入ったあとに押すと、その場所で作る
    const wt = `${app}/.claude/worktrees/x`;
    execFileSync('git', ['-C', app, 'worktree', 'add', '-q', '-b', 'x', wt]);
    h.update('alpha', {cwd: wt});
    await h.keys('C-q', 'C-w');
    await h.waitFor(/Workbench created\. Run "whatnext workbench" in a split to see it\./);
    expect(h.inner('display', '-p', '-t', '=sh-a0000000:', '#{pane_current_path}').trim()).toBe(wt);
    await h.keys('C-q', 'C-w');
    await h.waitFor(/Workbench already exists for alpha\./);
    await h.startWorkbench();
    await h.waitFor(() => wbClient()?.session === 'sh-a0000000', 5000);
    await h.keysTo('wb', 'C-q', 'C-v');
    await h.waitFor(/Opened .*worktrees\/x in VS Code\./, 5000, 'wb');
    expect(h.file('open.log')).toContain(`vscode://file${wt}/?windowId=_blank`);
    await h.keysTo('wb', 'C-q', 'c');
    await sleep(400);
    expect(h.inner('list-windows', '-t', '=sh-a0000000', '-F', '#{window_index}').trim().split('\n').length).toBe(2);
    await h.keysTo('wb', 'C-q', 'C-l');
    await h.waitFor(/^> alpha/m);
  });

  it('60: whatnext の画面を閉じているときに作業台の画面で一覧に戻るキーを押すと、何もせず知らせる', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    await h.start();
    await h.keys('w');
    await h.startWorkbench();
    await h.waitFor(() => wbClient()?.session === 'sh-a0000000', 5000);
    execFileSync('tmux', ['-L', h.outer, 'kill-session', '-t', '=main']);
    await sleep(500);
    await h.keysTo('wb', 'C-q', 'C-l');
    await h.waitFor(/The list is not open\. Run "whatnext" to open it\./, 5000, 'wb');
  });

  it('29: 作業台を持つセッションを消すと作業台も閉じ、動いていれば確認する。作業台の画面は次のものに切り替わる', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha', state: 'stopped', pid: undefined, status: undefined}), bg('b', {name: 'beta'})]);
    await h.start();
    await h.select('alpha');
    await h.keys('w');
    await h.startWorkbench();
    await h.waitFor(() => wbClient()?.session === 'sh-a0000000', 5000);
    h.inner('send-keys', '-t', '=sh-a0000000:', 'sleep 1004', 'Enter');
    await sleep(500);
    await h.keys('C-x');
    await h.waitFor(/Press Ctrl\+X again within 2s to delete\./);
    await h.keys('C-x');
    await h.waitFor(/Delete alpha and stop sleep 1004\? \[y\/N\]/);
    await h.keys('n');
    await h.waitFor(/alpha +Stopped/);
    expect(h.sessions()).toContain('sh-a0000000');
    await h.keys('C-x');
    await sleep(300);
    await h.keys('C-x');
    await h.waitFor(/Delete alpha and stop/);
    await h.keys('y');
    await h.waitFor(s => !/alpha/.test(s), 8000);
    expect(h.sessions()).not.toContain('sh-a0000000');
    await h.waitFor(/No workbench for beta/, 5000, 'wb');
  });
});

describe('終了と、端末のウィンドウを閉じたとき', () => {
  it('31・11: 作業台で動いていれば確認し、y ですべて閉じて終了する。セッションは動き続ける', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha', state: 'working', status: 'busy'})]);
    await h.start();
    await h.keys('w');
    h.inner('send-keys', '-t', '=sh-a0000000:', 'sleep 1005', 'Enter');
    await sleep(500);
    await h.keys('q');
    await h.waitFor(/Quit and stop 1 running command\? alpha: sleep 1005 \[y\/N\]/);
    await h.keys('Enter');
    await h.waitFor(s => !/Quit and stop/.test(s));
    expect(h.sessions()).toContain('sh-a0000000');
    await h.keys('q');
    await h.waitFor(/Quit and stop/);
    await h.keys('y');
    await h.waitFor(/\[exit 0\]/);
    expect(h.sessions()).toEqual([]);
    expect(h.calls().some(c => c.args[0] === 'stop')).toBe(false);
  });

  it('31: 何も動いていなければ確認せずに終了する', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    await h.start();
    await h.keys('w');
    await h.keys('q');
    await h.waitFor(/\[exit 0\]/);
  });

  it('32: 端末のウィンドウを閉じても終了せず、起動し直すと同じ一覧に戻り、見ていたセッションが先頭に上がる', async () => {
    h = new Harness();
    const app = h.repo('app');
    h.agents([bg('a', {cwd: app, name: 'alpha'}), bg('b', {cwd: app, name: 'beta', state: 'working', status: 'busy'})]);
    await h.start();
    await h.select('alpha');
    await h.keys('e');
    await h.type('メモ');
    await h.keys('Enter');
    await h.keys('f');
    await h.type('beta');
    await h.keys('Enter');
    await h.waitFor(/alpha +Waiting/);
    await h.select('beta');
    await h.keys('w');
    h.inner('send-keys', '-t', '=sh-b0000000:', 'sleep 1006', 'Enter');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to b0000000/);
    execFileSync('tmux', ['-L', h.outer, 'kill-session', '-t', '=main']);
    await sleep(800);
    expect(h.sessions()).toContain('list');
    await h.start();
    const s = await h.waitFor(/^> └ beta/m);
    expect(s).toMatch(/alpha +Waiting/);
    expect(s).toMatch(/↳ メモ/);
    expect(h.inner('list-panes', '-t', '=sh-b0000000:', '-F', '#{pane_current_command}').trim()).toBe('sleep');
    expect(h.state().seen[sid('b')].attached).toBeGreaterThan(h.state().seen[sid('a')].first);
  });

  it('16: 別の端末のウィンドウで起動すると、一覧が新しいウィンドウに移り、前のウィンドウはシェルに戻る', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    await h.start();
    h.open('second', `${h.envLine()} node ${CLI}`);
    await h.waitFor(/SESSION/, 8000, 'second');
    await h.waitFor(/\[exit 0\]/, 5000, 'main');
    expect(h.clients().length).toBe(1);
  });

  it('46: 一覧のプロセスが異常終了したあとに起動し直すと、作業台で動いているものを引き継ぐかを聞く', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'}), bg('b', {name: 'beta'})]);
    await h.start();
    await h.keys('w');
    await h.select('beta');
    await h.keys('w');
    h.inner('send-keys', '-t', '=sh-a0000000:', 'sleep 1007', 'Enter');
    // 前の版で作った作業台のステータス行に見立てる
    h.inner('set', '-t', '=sh-a0000000:', 'status-format[0]', 'old');
    await sleep(500);
    const pid = Number(h.inner('show', '-gv', '@wn_pid').trim());
    process.kill(pid, 'SIGKILL');
    await h.waitFor(/\[exit 0\]/);
    await h.start({wait: false});
    await h.waitFor(/1 command is still running from a previous whatnext: a0000000: sleep 1007\. Keep them\? \[Y\/n\]/);
    await sleep(300);
    expect(h.sessions()).not.toContain('sh-b0000000');
    await h.keys('Enter');
    await h.waitFor(/SESSION/);
    expect(h.inner('list-panes', '-t', '=sh-a0000000:', '-F', '#{pane_current_command}').trim()).toBe('sleep');
    expect(h.inner('show', '-v', '-t', '=sh-a0000000:', 'status-format[0]')).toMatch(/\^Q%% split/);
    // n なら止める
    process.kill(Number(h.inner('show', '-gv', '@wn_pid').trim()), 'SIGKILL');
    await h.waitFor(/\[exit 0\]/);
    await h.start({wait: false});
    await h.waitFor(/Keep them\? \[Y\/n\]/);
    await h.keys('n');
    await h.waitFor(/SESSION/);
    await sleep(300);
    expect(h.sessions()).not.toContain('sh-a0000000');
  });
});
