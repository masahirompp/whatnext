// 画面の通し: 作業台と作業台の画面(シナリオ 25、26、28、30、49、57、58、59、60)。
// 外側の tmux のセッションを2つ立て、片方で whatnext、もう片方で whatnext workbench を動かす(端末の分割の代わり)。

import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {Harness, ROOT, sleep} from './harness.js';

let h: Harness;
afterEach(() => h?.cleanup());

const wbSession = () => h.clients().find(c => c.session.startsWith('sh-') || c.session === 'wbguide')?.session;

async function setup(n = 2): Promise<void> {
  h = new Harness();
  h.setAgents(Array.from({length: n}, (_, i) => h.row(i + 1, {name: ['alpha', 'beta', 'gamma'][i] as string})));
  h.open('t', [], {cols: 140});
  await h.waitFor('t', n > 1 ? 'beta' : 'alpha');
}

describe('作業台', () => {
  it('25、57: 作業台の画面は案内を出し、Enter でその場所にシェルが開く。一覧のカーソルに付いていく', async () => {
    await setup();
    await h.select('t', 'alpha');
    h.open('wb', ['workbench'], {cols: 80, rows: 20});
    await h.waitFor('wb', 'No workbench for alpha yet.');
    const s = await h.waitFor('wb', `Enter: open a shell in ${h.repo}`);
    expect(s).toMatch(/workbench: alpha/);
    await h.keys('t', 'Down');
    await h.waitFor('wb', 'No workbench for beta yet.');
    expect(h.sessions().filter(x => x.startsWith('sh-'))).toEqual([]);
    await h.keys('t', 'Up');
    await h.waitFor('wb', 'No workbench for alpha yet.');
    await h.keys('wb', 'Enter');
    await h.waitFor('wb', /workbench: alpha {2}0:/);
    expect(wbSession()).toBe('sh-a0000001');
    await h.type('wb', 'pwd');
    await h.keys('wb', 'Enter');
    await h.waitFor('wb', new RegExp(`^${h.repo.replace(/^\/tmp/, '(/private)?/tmp')}$`, 'm'));
    // attach すると作業台の画面もそのセッションの作業台に切り替わる
    await h.select('t', 'beta');
    await h.waitFor('wb', 'No workbench for beta yet.');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000002');
    await h.waitFor('wb', 'No workbench for beta yet.');
  });

  it('26: 作業台を分割して動かしたコマンドは、別のセッションに移って戻っても動き続け、配置も元のまま', async () => {
    await setup();
    await h.select('t', 'alpha');
    h.open('wb', ['workbench'], {cols: 100, rows: 24});
    await h.waitFor('wb', 'No workbench for alpha yet.');
    await h.keys('t', 'w');
    await h.waitFor('wb', /workbench: alpha/);
    await h.keys('wb', 'C-q', '%');
    await sleep(500);
    expect(h.tmux('list-panes', '-t', '=sh-a0000001:', '-F', '#{pane_id}').trim().split('\n')).toHaveLength(2);
    h.tmux('send-keys', '-t', '=sh-a0000001:.0', 'sleep 1011', 'Enter');
    h.tmux('send-keys', '-t', '=sh-a0000001:.1', 'sleep 1012', 'Enter');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000001');
    await h.keys('t', 'C-q', 'C-l');
    await h.waitFor('t', 'Last attached');
    await h.select('t', 'beta');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000002');
    await h.waitFor('wb', 'No workbench for beta yet.');
    await h.keys('t', 'C-q', 'C-l');
    await h.select('t', 'alpha');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000001');
    await h.waitFor('wb', /workbench: alpha/);
    expect(h.tmux('list-panes', '-t', '=sh-a0000001:', '-F', '#{pane_id}').trim().split('\n')).toHaveLength(2);
    await h.waitFor('t', '⚙ sleep 1011 · sleep 1012');
    // 作業台の画面を閉じて開き直しても同じ
    h.closeTerminal('wb');
    await sleep(500);
    h.open('wb2', ['workbench'], {cols: 100, rows: 24});
    await h.waitFor('wb2', /workbench: alpha/);
    expect(h.tmux('list-panes', '-t', '=sh-a0000001:', '-F', '#{pane_id}').trim().split('\n')).toHaveLength(2);
  });

  it('28: 作業台のシェルで Ctrl+Z がジョブ停止として効き、最後のシェルで exit すると案内が出る', async () => {
    await setup(1);
    h.open('wb', ['workbench'], {cols: 80, rows: 20});
    await h.waitFor('wb', 'No workbench for alpha yet.');
    await h.keys('wb', 'Enter');
    await h.waitFor('wb', /workbench: alpha/);
    await h.waitFor('wb', /\$ ?$/m);
    await h.type('wb', 'sleep 1013');
    await h.keys('wb', 'Enter');
    await sleep(300);
    await h.keys('wb', 'C-z');
    await h.waitFor('wb', /Stopped|suspended/i);
    await h.type('wb', 'kill %1');
    await h.keys('wb', 'Enter');
    await sleep(300);
    await h.type('wb', 'exit');
    await h.keys('wb', 'Enter');
    await h.waitFor('wb', 'Workbench closed.');
    await sleep(500);
    expect(h.screen('wb')).toContain('No workbench for alpha yet.');
    expect(h.sessions()).not.toContain('sh-a0000001');
    await h.keys('wb', 'Enter');
    await h.waitFor('wb', /workbench: alpha {2}0:/);
  });

  it('28: claude の画面では ctrl+b などがそのまま claude に届く', async () => {
    await setup(1);
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.keys('t', 'C-b', 'C-g');
    await sleep(300);
    expect(h.screen('t')).toContain('FAKE CLAUDE SCREEN');
    expect(h.clients()[0]?.session).toBe('a0000001');
  });

  it('30、49: 作業台で動いているものが一覧の行の下と claude の画面の左下に出て、終わると消える', async () => {
    await setup(1);
    await h.keys('t', 'w');
    await h.waitFor('t', 'Workbench created. Run "whatnext workbench" in a split to see it.');
    h.tmux('send-keys', '-t', '=sh-a0000001:', 'sleep 3 && echo done', 'Enter');
    await sleep(300);
    await h.keys('t', 'r');
    await h.waitFor('t', '⚙ sleep 3');
    await h.keys('t', 'Enter');
    await h.waitFor('t', /^⚙ sleep 3 /m, 6000);
    await h.waitFor('t', /^⌂ workbench \(shell\) /m, 10000);
    await h.keys('t', 'C-q', 'C-l');
    await h.keys('t', 'r');
    await h.waitFor('t', 'Refreshed.');
    expect(h.screen('t')).not.toContain('⚙');
  });

  it('58: ctrl+q ctrl+w で作業台を作り、すでにあれば作らない。作業台の画面を開くとその作業台が映る', async () => {
    await setup(1);
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.keys('t', 'C-q', 'C-w');
    await h.waitFor('t', 'Workbench created. Run "whatnext workbench" in a split to see it.');
    expect(h.sessions()).toContain('sh-a0000001');
    await sleep(2200);
    await h.keys('t', 'C-q', 'C-w');
    await h.waitFor('t', 'Workbench already exists for alpha.');
    h.open('wb', ['workbench'], {cols: 80, rows: 20});
    await h.waitFor('wb', /workbench: alpha {2}0:/);
  });

  it('58: 作る直前に --json を読み直し、その時点の cwd で開く', async () => {
    await setup(1);
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    h.update('a0000001', {cwd: '/tmp'});
    await h.keys('t', 'C-q', 'C-w');
    await h.waitFor('t', 'Workbench created.');
    expect(h.tmux('display', '-p', '-t', '=sh-a0000001:', '#{pane_current_path}').trim()).toMatch(
      /^(\/private)?\/tmp$/,
    );
  });

  it('59: 2つ目の作業台の画面を開くと新しいほうが映し、前のほうはシェルに戻る。一覧がなければ断る', async () => {
    await setup(1);
    h.open('wb', ['workbench'], {cols: 80, rows: 20});
    await h.waitFor('wb', 'No workbench for alpha yet.');
    h.open('wb2', ['workbench'], {cols: 80, rows: 20});
    await h.waitFor('wb2', 'No workbench for alpha yet.');
    await h.waitFor('wb', /\[exit 0\]/);
    // whatnext の画面だけを閉じても、作業台の画面は映したまま。開き直すとまた付いていく
    h.closeTerminal('t');
    await sleep(500);
    expect(h.screen('wb2')).toContain('No workbench for alpha yet.');
    h.open('t2', [], {cols: 140});
    await h.waitFor('t2', 'alpha');
    await h.keys('t2', 'w');
    await h.waitFor('wb2', /workbench: alpha {2}0:/);
    await h.keys('t2', 'q');
    await h.waitFor('wb2', /\[exit 0\]/);
    const r = spawnSync('node', [join(ROOT, 'dist', 'cli.js'), 'workbench'], {
      encoding: 'utf8',
      env: {...process.env, ...h.env()},
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('whatnext is not running. Start whatnext first.');
  });

  it('60: 作業台の画面で ctrl+q ctrl+l は whatnext の画面を一覧に戻し、ctrl+q c は作業台にウィンドウを作る', async () => {
    await setup();
    h.open('wb', ['workbench'], {cols: 80, rows: 20});
    await h.select('t', 'alpha');
    await h.keys('t', 'w');
    await h.waitFor('wb', /workbench: alpha/);
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000001');
    await h.keys('wb', 'C-q', 'c');
    await h.waitFor('wb', /0:\S* 1:\S*\*/);
    await h.keys('wb', 'C-q', 'C-l');
    await h.waitFor('t', 'Last attached');
    // 作業台の画面で ctrl+q ctrl+j: whatnext の画面が次のセッションへ移り、作業台の画面も付いていく
    await h.keys('wb', 'C-q', 'C-j');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000002');
    await h.waitFor('wb', 'No workbench for beta yet.');
  });

  it('60、48: 作業台の画面で ctrl+q ctrl+e を押すと、その作業台のセッションの開く先のメニューが作業台の画面に出る', async () => {
    await setup(1);
    h.open('wb', ['workbench'], {cols: 80, rows: 20});
    await h.keys('t', 'w');
    await h.waitFor('wb', /workbench: alpha/);
    await h.keys('wb', 'C-q', 'C-e');
    const s = await h.waitFor('wb', 'Show alpha in:');
    expect(s).toContain('VS Code:');
    expect(s).toContain('No pull request for this session.');
    expect(h.screen('t')).not.toContain('Show alpha in:');
    await h.keys('wb', '1');
    await h.waitFor('wb', 'Opened');
    expect(h.log('open.log')[0]).toMatch(/^vscode:\/\/file.*\/repo\/\?windowId=_blank$/);
  });

  it('60: whatnext の画面を閉じているときに一覧に戻るキーを押すと、そのことが示される', async () => {
    await setup(1);
    h.open('wb', ['workbench'], {cols: 80, rows: 20});
    await h.waitFor('wb', 'No workbench for alpha yet.');
    h.closeTerminal('t');
    await sleep(500);
    await h.keys('wb', 'C-q', 'C-l');
    await h.waitFor('wb', 'The list is not open. Run "whatnext" to open it.');
  });

  it('対話セッションの行では、作業台の画面にそのことが示され、w は何もしない', async () => {
    h = new Harness();
    h.setAgents([
      {
        kind: 'interactive',
        sessionId: 'ffff0000-0000-4000-8000-000000000001',
        cwd: '/tmp',
        name: 'tty-x',
        pid: 4242,
        status: 'busy',
      },
    ]);
    h.open('t');
    await h.waitFor('t', 'tty-x (tty)');
    h.open('wb', ['workbench'], {cols: 80, rows: 20});
    await h.waitFor('wb', 'tty-x is an interactive session. It has no workbench.');
    await h.keys('t', 'w');
    await h.waitFor('t', 'tty-x is an interactive session. It has no workbench.');
    expect(h.sessions().filter(s => s.startsWith('sh-'))).toEqual([]);
  });
});
