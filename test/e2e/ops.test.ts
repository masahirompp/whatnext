// 画面の通し: 停止と削除、保留、待ち先、新しいセッション、外のアプリで開く
// (シナリオ 8、9、14、15、17、18、20、21、22、29、40、43、44、47、48、51、52、53、54、55)。

import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {Harness, sleep} from './harness.js';

let h: Harness;
afterEach(() => h?.cleanup());

const perm = {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'};
const busy = {state: 'working', status: 'busy'};

describe('停止と削除', () => {
  it('9: Ctrl+X で止まり(Stopping...)、2秒以内にもう一度押すと消える(Deleting...)', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha', ...busy}), h.row(2, {name: 'beta'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.select('t', 'alpha');
    await h.keys('t', 'C-x');
    await h.waitFor('t', /alpha +Stopped/);
    expect(h.calls()).toContain('stop a0000001');
    await h.keys('t', 'C-x');
    await h.waitGone('t', /alpha/);
    expect(h.calls()).toContain('rm a0000001');
    expect(h.agents().map(r => r.name)).toEqual(['beta']);
  });

  it('9: 2秒を過ぎてから押した2回目は削除にならない。ほかのキーで待ち受けが取り消される', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha', state: 'stopped', status: undefined, pid: undefined})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'C-x');
    await h.waitFor('t', 'Press Ctrl+X again within 2s to delete.');
    expect(h.calls().filter(c => c.startsWith('stop'))).toEqual([]);
    await h.keys('t', 'Down');
    await h.keys('t', 'C-x');
    await h.waitFor('t', 'Press Ctrl+X again within 2s to delete.');
    await sleep(2200);
    await h.keys('t', 'C-x');
    await sleep(500);
    expect(h.calls().filter(c => c.startsWith('rm'))).toEqual([]);
  });

  it('9: push していないコミットがあれば英語で聞き、y で消える。未コミットの変更なら断りの文言が出て残る', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha', unpushed: true}), h.row(2, {name: 'beta', uncommitted: true})]);
    h.open('t');
    await h.waitFor('t', 'beta');
    await h.select('t', 'alpha');
    await h.keys('t', 'C-x', 'C-x');
    await h.waitFor('t', 'Discard 1 unpushed commit and delete session a0000001? [y/N]');
    await h.keys('t', 'y');
    await h.waitGone('t', /alpha/);
    expect(h.calls()).toContain('rm a0000001 --discard-unpushed abc1234@a0000001');
    // 消した行の直後は、カーソルが移った行への Ctrl+X を2秒受け付けない(51)。
    await sleep(2200);
    await h.select('t', 'beta');
    await h.keys('t', 'C-x', 'C-x');
    await h.waitFor('t', 'The worktree has uncommitted changes.');
    expect(h.screen('t')).toMatch(/beta +Review/);
  });

  it('40: 止める操作が失敗すると、出力と2回目で削除できることが出る', async () => {
    h = new Harness();
    h.behave('stop', 'fail');
    h.setAgents([h.row(1, {name: 'alpha', ...busy})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'C-x');
    await h.waitFor('t', 'Stop failed: could not stop a0000001: fake failure (Ctrl+X again to delete)');
    expect(h.screen('t')).not.toMatch(/Stopped alpha/);
  });

  it('51: 選んでいる行が一覧から消えてカーソルが移った直後の Ctrl+X は受け付けない', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta', ...busy})]);
    h.open('t');
    await h.waitFor('t', 'beta');
    await h.select('t', 'alpha');
    h.update('a0000001', null);
    await h.keys('t', 'r');
    await h.waitGone('t', /alpha/);
    await h.keys('t', 'C-x');
    await h.waitFor('t', 'Ctrl+X ignored: alpha left the list and the selection moved.');
    expect(h.calls().filter(c => c.startsWith('stop'))).toEqual([]);
  });

  it('29: 作業台で動いているものがあるセッションを消すときは確認が出て、N なら消さない。消すと作業台も閉じる', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'w');
    await h.waitFor('t', 'Workbench created.');
    h.tmux('send-keys', '-t', '=sh-a0000001:', 'sleep 1021', 'Enter');
    await sleep(500);
    await h.keys('t', 'C-x', 'C-x');
    await h.waitFor('t', 'Delete alpha and stop running commands? alpha: sleep 1021 [y/N]');
    await h.keys('t', 'n');
    await h.waitGone('t', 'Delete alpha');
    expect(h.sessions()).toContain('sh-a0000001');
    await sleep(2200);
    await h.keys('t', 'C-x', 'C-x');
    await h.waitFor('t', 'Delete alpha and stop running commands?');
    await h.keys('t', 'y');
    await h.waitGone('t', /alpha/);
    expect(h.sessions()).not.toContain('sh-a0000001');
  });

  it('53: attach している間に ctrl+q ctrl+x を押すと一覧に戻って止まり、続けて押すと消える', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha', ...busy}), h.row(2, {name: 'beta'})]);
    h.open('t');
    await h.waitFor('t', 'beta');
    await h.select('t', 'alpha');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000001');
    await h.keys('t', 'C-q', 'C-x');
    await h.waitFor('t', /alpha +Stopped/);
    await h.keys('t', 'C-q', 'C-x');
    await h.waitGone('t', /alpha/);
    expect(h.calls()).toContain('rm a0000001');
  });
});

describe('保留', () => {
  it('15: h で理由を入れて保留にし、カーソルは次の行へ。h で戻す。再起動しても残る', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha', ...perm}), h.row(2, {name: 'beta'})]);
    h.open('t');
    await h.waitFor('t', 'beta');
    await h.select('t', 'alpha');
    await h.keys('t', 'h');
    await h.waitFor('t', 'Put alpha on hold. Reason (optional):');
    await h.type('t', 'ask Bob');
    await h.keys('t', 'Enter');
    let s = await h.waitFor('t', 'On hold');
    expect(s).toContain('Put alpha on hold. It comes back when you attach and work on it, or press h on it.');
    expect(s).toMatch(/On hold\n {2}alpha +Permission[^\n]*\n {4}↳ ask Bob/);
    expect(h.selected('t')).toMatch(/^> beta/);
    expect(h.stateFile()).toMatchObject({version: 1, holds: {[h.row(1).sessionId as string]: 'ask Bob'}});
    // 再起動しても残る
    await h.keys('t', 'q');
    await h.waitFor('t', /\[exit 0\]/);
    h.open('t2');
    s = await h.waitFor('t2', 'On hold');
    expect(s).toContain('↳ ask Bob');
    await h.select('t2', 'alpha');
    await h.keys('t2', 'h');
    await h.waitFor('t2', 'alpha is back in the list.');
    expect(h.screen('t2')).not.toContain('On hold');
  });

  it('15: 保留の理由は、一言や作業台で動いているものより先に、行のすぐ下に出る', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'w');
    await h.waitFor('t', 'Workbench created.');
    h.tmux('send-keys', '-t', '=sh-a0000001:', 'sleep 1031', 'Enter');
    await sleep(500);
    await h.keys('t', 'h');
    await h.type('t', 'ask Bob');
    await h.keys('t', 'Enter');
    await h.keys('t', 'r');
    const s = await h.waitFor('t', '⚙ sleep 1031');
    expect(s).toMatch(/[> ] alpha +Review[^\n]*\n {4}↳ ask Bob\n {4}⚙ sleep 1031/);
  });

  it('15: Esc で保留せずに閉じる。保留の行に attach して何もせずに戻ると残り、指示を出して戻ると解ける', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta'})]);
    h.open('t');
    await h.waitFor('t', 'beta');
    await h.select('t', 'alpha');
    await h.keys('t', 'h', 'Escape');
    await sleep(300);
    expect(h.screen('t')).not.toContain('On hold');
    await h.keys('t', 'h', 'Enter');
    await h.waitFor('t', 'On hold');
    await h.select('t', 'alpha');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000001');
    await h.keys('t', 'C-q', 'C-l');
    await h.waitFor('t', 'On hold');
    expect(h.selected('t')).toMatch(/^> alpha/);
    expect(h.screen('t')).not.toContain('Last attached');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN a0000001');
    await h.type('t', 'do it');
    await h.keys('t', 'Enter');
    await h.keys('t', 'C-q', 'C-l');
    const s = await h.waitFor('t', 'Last attached');
    expect(s).not.toContain('On hold');
  });

  it('52: attach している間に ctrl+q ctrl+h を押すと一覧に戻り、保留の理由の入力欄が開く', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta'})]);
    h.open('t');
    await h.waitFor('t', 'beta');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.keys('t', 'C-q', 'C-h');
    await h.waitFor('t', /Put \w+ on hold\. Reason/);
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'On hold');
    await h.select('t', 'alpha');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.keys('t', 'C-q', 'h');
    await h.waitFor('t', 'is back in the list.');
  });
});

describe('待ち先', () => {
  it('20、44: f のメニューに一覧と同じ順で並び、選ぶと待ち先に加わって入れ子になる。待ち先が終わると done', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta', ...busy}), h.row(3, {name: 'gamma', ...perm})]);
    h.open('t');
    await h.waitFor('t', 'gamma');
    await h.select('t', 'alpha');
    await h.keys('t', 'f');
    const menu = await h.waitFor('t', 'alpha waits for:');
    const after = menu.slice(menu.indexOf('alpha waits for:'));
    expect(after.indexOf('New session')).toBeLessThan(after.indexOf('gamma'));
    expect(after.indexOf('gamma')).toBeLessThan(after.indexOf('beta'));
    await h.type('t', 'bet');
    await h.keys('t', 'Enter');
    let s = await h.waitFor('t', /alpha +Waiting/);
    expect(s).toMatch(/[> ] alpha +Waiting[^\n]*\n {2}└ beta +Working/);
    // B が終わると A は元の段に戻り、done が出る
    h.update('a0000002', {state: 'done', status: 'idle'});
    await h.keys('t', 'r');
    s = await h.waitFor('t', '↳ beta done');
    expect(s).toMatch(/alpha +Review/);
    // 再び稼働すると Waiting に戻り、done は消える
    h.update('a0000002', busy);
    await h.keys('t', 'r');
    s = await h.waitFor('t', /alpha +Waiting/);
    expect(s).not.toContain('done');
    expect(h.stateFile()).toMatchObject({waits: {[h.row(1).sessionId as string]: [h.row(2).sessionId]}});
  });

  it('20、21: 一周する関係とほかの待ち元の待ち先は並ばない。待ち先を保留にすると (on hold)', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta', ...busy}), h.row(3, {name: 'gamma'})]);
    h.open('t');
    await h.waitFor('t', 'gamma');
    await h.select('t', 'alpha');
    await h.keys('t', 'f');
    await h.type('t', 'beta');
    await h.keys('t', 'Enter');
    await h.waitFor('t', /alpha +Waiting/);
    await h.select('t', 'beta');
    await h.keys('t', 'f');
    const m = await h.waitFor('t', 'beta waits for:');
    const after = m.slice(m.indexOf('beta waits for:'));
    expect(after).not.toMatch(/\balpha\b/);
    await h.keys('t', 'Escape');
    await h.select('t', 'gamma');
    await h.keys('t', 'f');
    const m2 = await h.waitFor('t', 'gamma waits for:');
    expect(m2.slice(m2.indexOf('gamma waits for:'))).not.toMatch(/\bbeta\b/);
    await h.keys('t', 'Escape');
    await h.select('t', 'beta');
    await h.keys('t', 'h', 'Enter');
    await h.waitFor('t', 'beta (on hold)');
    // 根を保留にすると組ごと保留の組へ
    await h.select('t', 'alpha');
    await h.keys('t', 'h', 'Enter');
    const s = await h.waitFor('t', 'On hold');
    expect(s.slice(s.indexOf('On hold'))).toMatch(/alpha[\s\S]*beta \(on hold\)/);
  });

  it('20: 印の付いた待ち先を選ぶと外れる。外して待ちの段から出ると done が出る', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta', ...busy}), h.row(3, {name: 'gamma'})]);
    h.open('t');
    await h.waitFor('t', 'gamma');
    await h.select('t', 'alpha');
    for (const n of ['beta', 'gamma']) {
      await h.keys('t', 'f');
      await h.type('t', n);
      await h.keys('t', 'Enter');
    }
    await h.waitFor('t', /alpha +Waiting/);
    await h.keys('t', 'f');
    await h.waitFor('t', /✓ beta/);
    await h.type('t', 'beta');
    await h.keys('t', 'Enter');
    const s = await h.waitFor('t', '↳ gamma done');
    expect(s).toMatch(/alpha +Review/);
  });

  it('22: 待ち元を消すと待ち先を一緒に消すかを聞かれ、y で消える', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'}), h.row(2, {name: 'beta', ...busy}), h.row(3, {name: 'gamma'})]);
    h.open('t');
    await h.waitFor('t', 'gamma');
    await h.select('t', 'alpha');
    await h.keys('t', 'f');
    await h.type('t', 'beta');
    await h.keys('t', 'Enter');
    await h.waitFor('t', /alpha +Waiting/);
    await h.select('t', 'alpha');
    await h.keys('t', 'C-x', 'C-x');
    await h.waitFor('t', 'Also delete 1 session this one was waiting for? (beta) [y/N]');
    await h.keys('t', 'y');
    await h.waitGone('t', /alpha|beta/);
    expect(h.calls()).toContain('stop a0000002');
    expect(h.agents().map(r => r.name)).toEqual(['gamma']);
  });

  it('22: N なら待ち元だけが消える。待ち元が消えなかったときは待ち先も残る', async () => {
    h = new Harness();
    h.setAgents([
      h.row(1, {name: 'alpha', uncommitted: true}),
      h.row(2, {name: 'beta', ...busy}),
      h.row(4, {name: 'delta'}),
      h.row(5, {name: 'eps'}),
    ]);
    h.open('t');
    await h.waitFor('t', 'eps');
    await h.select('t', 'alpha');
    await h.keys('t', 'f');
    await h.type('t', 'beta');
    await h.keys('t', 'Enter');
    await h.waitFor('t', /alpha +Waiting/);
    await h.keys('t', 'C-x', 'C-x');
    await h.waitFor('t', 'Also delete 1 session');
    await h.keys('t', 'y');
    await h.waitFor('t', 'uncommitted changes');
    expect(h.agents().map(r => r.name)).toContain('beta');
    await h.select('t', 'delta');
    await h.keys('t', 'f');
    await h.type('t', 'eps');
    await h.keys('t', 'Enter');
    await h.waitFor('t', /└ eps/);
    await h.select('t', 'delta');
    await h.keys('t', 'C-x', 'C-x');
    await h.waitFor('t', 'Also delete 1 session');
    await h.keys('t', 'n');
    await h.waitGone('t', /delta/);
    expect(h.agents().map(r => r.name)).toContain('eps');
  });

  it('17、55: f の New session で起動したセッションが待ち先になる。ctrl+q ctrl+f でも同じメニューが出る', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.keys('t', 'C-q', 'C-f');
    await h.waitFor('t', 'alpha waits for:');
    await h.keys('t', 'Enter');
    const dir = await h.waitFor('t', 'New session — working directory:');
    expect(dir.split('\n').find(l => l.startsWith('> '))).toContain(h.repo.split('/').pop());
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'model:');
    await h.keys('t', 'Enter');
    await h.waitFor('t', /FAKE CLAUDE SCREEN new/);
    await h.keys('t', 'C-q', 'C-l');
    const s = await h.waitFor('t', /└ new\d+/);
    expect(s).toMatch(/alpha +Question \(blocked\)|alpha +Review|alpha +Waiting/);
    expect(h.stateFile()).toMatchObject({waits: {[h.row(1).sessionId as string]: [expect.stringMatching(/^new/)]}});
  });
});

describe('新しいセッション', () => {
  it('8、43: 候補を絞り込み、Other... で存在しないパスを入れると断られ、Esc で1つずつ戻る', async () => {
    const other = '/tmp';
    h = new Harness({ghq: [join('/tmp', 'nowhere', 'ghqrepo')]});
    mkdirSync(join(h.root, 'zz-target'), {recursive: true});
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'n');
    // 候補は ghq を待ってから並ぶ。
    let s = await h.waitFor('t', 'ghqrepo');
    expect(s).toContain('ghqrepo');
    await h.type('t', 'ghq');
    s = await h.waitFor('t', /> ghqrepo/);
    await h.keys('t', 'Down', 'Enter');
    await h.waitFor('t', 'Directory: ghq');
    await h.keys('t', 'BSpace', 'BSpace', 'BSpace');
    await h.type('t', '/no/such/dir');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'Not a directory: /no/such/dir');
    for (let i = 0; i < 12; i++) await h.keys('t', 'BSpace');
    await h.type('t', '../repo');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'Not a directory: ../repo');
    await h.keys('t', 'Escape');
    await h.waitFor('t', 'New session — working directory:');
    await h.keys('t', 'Escape');
    await h.waitGone('t', 'New session');
    // Other... で入れたディレクトリで、モデルを Other... から入れて起動する
    await h.keys('t', 'n');
    await h.waitFor('t', 'New session — working directory:');
    await h.type('t', 'zzzz');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'Directory: zzzz');
    for (let i = 0; i < 4; i++) await h.keys('t', 'BSpace');
    await h.type('t', other);
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'model:');
    await h.keys('t', 'Escape');
    await h.waitFor('t', 'working directory:');
    await h.keys('t', 'Escape');
    await h.keys('t', 'n');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'model:');
    await h.keys('t', 'Down', 'Enter');
    await h.waitFor('t', 'Model:');
    await h.keys('t', 'Enter');
    await sleep(300);
    expect(h.screen('t')).toContain('Model:');
    await h.type('t', 'haiku');
    await h.keys('t', 'Enter');
    await h.waitFor('t', /FAKE CLAUDE SCREEN new/);
    expect(h.calls().find(c => c.startsWith('--bg'))).toMatch(/^--bg --model haiku --settings /);
    await h.keys('t', 'C-q', 'C-l');
    await h.waitFor('t', /Last attached\n> new\d+ +Question \(blocked\)/);
  });

  it('8: ghq がない環境でも起動できる', async () => {
    h = new Harness();
    h.setAgents([]);
    h.open('t');
    await h.waitFor('t', 'No sessions to show.');
    await h.keys('t', 'n');
    await h.waitFor('t', 'working directory:');
    await h.keys('t', 'Enter', 'Enter');
    await h.waitFor('t', /FAKE CLAUDE SCREEN new/);
    expect(h.calls().find(c => c.startsWith('--bg'))).toMatch(/^--bg --settings /);
  });

  it('47: 信頼していないディレクトリでは信頼の確認が出る。信頼するとそのまま attach、断ると Not trusted', async () => {
    h = new Harness();
    h.behave('trust', 'untrusted');
    h.open('t');
    await h.waitFor('t', 'No sessions to show.');
    await h.keys('t', 'n', 'Enter', 'Enter');
    await h.waitFor('t', 'Do you trust the files in this folder?');
    await h.keys('t', '2');
    await h.waitFor('t', /Not trusted: /);
    await h.keys('t', 'n', 'Enter', 'Enter');
    await h.waitFor('t', 'Do you trust the files in this folder?');
    await h.keys('t', '1');
    await h.waitFor('t', /FAKE CLAUDE SCREEN new/, 15000);
    expect(h.sessions().filter(s => s.startsWith('trust-'))).toEqual([]);
  });

  it('54: attach している間に ctrl+q ctrl+n を押すと一覧に戻り、候補の先頭がいたセッションのリポジトリ', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha', cwd: '/tmp'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.keys('t', 'C-q', 'C-n');
    const s = await h.waitFor('t', 'working directory:');
    const menu = s.slice(s.indexOf('working directory:')).split('\n');
    expect(menu.find(l => l.startsWith('> '))).toMatch(/^> tmp +\/tmp/);
    await h.keys('t', 'Escape');
    await h.waitFor('t', 'Last attached');
  });
});

describe('外のアプリで開く', () => {
  it('14: e で開く先のメニューが出る。PR があれば GitHub と vscode.dev も出る', async () => {
    h = new Harness({gh: true});
    const wt = join(h.root, 'wt');
    const {execFileSync} = await import('node:child_process');
    execFileSync('git', ['-C', h.repo, 'worktree', 'add', '-q', '-b', 'fix-login', wt]);
    const {writeFileSync} = await import('node:fs');
    writeFileSync(
      join(h.fake, 'gh.json'),
      JSON.stringify([{number: 12, state: 'OPEN', isDraft: false, url: 'https://github.com/me/app/pull/12'}]),
    );
    h.setAgents([h.row(1, {name: 'alpha', cwd: wt}), h.row(2, {name: 'beta'})]);
    h.open('t', [], {cols: 140});
    await h.waitFor('t', /alpha +Review +repo fix-login \(wt\) #12 \(open\)/);
    await h.select('t', 'alpha');
    await h.keys('t', 'e');
    const s = await h.waitFor('t', 'Show alpha in:');
    expect(s).toMatch(/\(1\) Pull request #12 on GitHub/);
    expect(s).toMatch(/\(2\) VS Code: .*wt/);
    expect(s).toMatch(/\(3\) Pull request #12 on vscode.dev/);
    await h.keys('t', '3');
    await h.waitFor('t', 'Opened pull request #12 on vscode.dev.');
    expect(h.log('open.log')).toEqual(['https://vscode.dev/github/me/app/pull/12']);
    await h.select('t', 'beta');
    await h.keys('t', 'e');
    const s2 = await h.waitFor('t', 'Show beta in:');
    expect(s2).toContain('No pull request for this session.');
    await h.keys('t', 'Enter');
    await h.waitFor('t', /Opened .*repo in VS Code\./);
  });

  it('48: attach している間に ctrl+q ctrl+e(ctrl+q e)で tmux のメニューが出て、選ぶと開いたものが示される', async () => {
    h = new Harness();
    h.setAgents([h.row(1, {name: 'alpha'})]);
    h.open('t');
    await h.waitFor('t', 'alpha');
    await h.keys('t', 'Enter');
    await h.waitFor('t', 'FAKE CLAUDE SCREEN');
    await h.keys('t', 'C-q', 'e');
    const s = await h.waitFor('t', 'Show alpha in:');
    expect(s).toContain('No pull request for this session.');
    await h.keys('t', '1');
    await h.waitFor('t', /Opened .*repo in VS Code\./);
    expect(h.log('open.log')[0]).toMatch(/^vscode:\/\/file.*\/repo\/\?windowId=_blank$/);
  });
});
