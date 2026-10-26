import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {bg, Harness, sid, sleep, tty} from './harness.js';

// 一覧と並び、attach、メモ(PRODUCT.md「受け入れシナリオ」)。

let h: Harness;
afterEach(() => h?.cleanup());

describe('一覧と並び', () => {
  it('78: AGE は会話記録の最初の時刻と初めて見た時刻の早いほうから数える。段が変わっても attach しても数え直さない', async () => {
    h = new Harness();
    h.agents([
      bg('a', {name: 'alpha'}),
      bg('b', {name: 'beta', state: 'working', status: 'busy'}),
      bg('c', {name: 'gamma'}),
    ]);
    const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();
    // gamma は3時間前に初めて見ていて、会話記録はそのあと(1時間前)にできた
    h.writeState({version: 3, notes: {}, waits: {}, seen: {[sid('c')]: {first: Date.now() - 3 * 3600000}}});
    h.transcript(sid('c'), [{type: 'user', message: {role: 'user', content: '始めて'}, timestamp: ago(60)}]);
    h.transcript(sid('a'), [
      {type: 'mode', mode: 'default'},
      {type: 'user', message: {role: 'user', content: '直して'}, timestamp: ago(2 * 24 * 60)},
      {
        type: 'assistant',
        message: {role: 'assistant', content: [{type: 'text', text: '直しました'}]},
        timestamp: ago(3),
      },
    ]);
    await h.start();
    expect(h.screen()).toMatch(/alpha +Review.* 2d$/m);
    expect(h.screen()).toMatch(/beta +Working.* <1m$/m);
    expect(h.screen()).toMatch(/gamma +Review.* 3h$/m);
    h.update('alpha', {state: 'working', status: 'busy'});
    await h.refresh();
    expect(h.screen()).toMatch(/alpha +Working.* 2d$/m);
    await h.select('alpha');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    await h.keys('C-q', 'C-l');
    await h.waitFor(/^> alpha/m);
    expect(h.screen()).toMatch(/alpha +Working.* 2d$/m);
  });

  it('1・61: リポジトリの区切りにまとまり、段、作ってからの時間、名前、場所が出る。見出しは選べない', async () => {
    h = new Harness();
    const app = h.repo('app');
    const infra = h.repo('infra');
    h.agents([
      bg('fix', {cwd: app, name: 'fix-login', state: 'done'}),
      bg('perm', {
        cwd: infra,
        name: 'refactor auth',
        state: 'blocked',
        status: 'waiting',
        waitingFor: 'permission prompt',
      }),
      bg('dlg', {cwd: app, name: 'dialog', state: 'blocked', status: 'waiting', waitingFor: 'dialog open'}),
    ]);
    await h.start();
    const s = h.screen();
    expect(s).toMatch(/^ {2}SESSION +STATUS +WHERE +CTX +AGE/m);
    expect(s).toMatch(/^── app ─+$/m);
    expect(s).toMatch(/^── infra ─+$/m);
    expect(s.indexOf('── app')).toBeLessThan(s.indexOf('── infra'));
    expect(s).toMatch(/refactor auth +Permission/);
    expect(s).toMatch(/dialog +Question \(dialog open\)/);
    // 見出しは飛ばす
    await h.select('refactor auth');
    await h.keys('Up');
    expect(h.screen()).toMatch(/^> (fix-login|dialog)/m);
  });

  it('1・61: WHERE には既定でないブランチ、(wt)、PR、根より下のパスが出て、区切りと同じリポジトリ名は出ない', async () => {
    h = new Harness();
    const app = h.repo('app');
    const wt = `${app}/.claude/worktrees/fix`;
    execFileSync('git', ['-C', app, 'worktree', 'add', '-q', '-b', 'fix-login', wt]);
    mkdirSync(join(app, 'pkg', 'web'), {recursive: true});
    writeFileSync(join(h.dir, 'pr.json'), JSON.stringify([{number: 12, state: 'OPEN', isDraft: false}]));
    h.agents([bg('a', {cwd: wt, name: 'fix-login'}), bg('b', {cwd: join(app, 'pkg', 'web'), name: 'web'})]);
    await h.start();
    await h.waitFor(/fix-login +Review +fix-login \(wt\) #12 \(open\)/);
    expect(h.screen()).toMatch(/web +Review +pkg\/web +-/);
  });

  it('66: 終了して起動し直すと、区切りの中の並びも同じで、カーソルは最も新しく attach したセッション', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'}), bg('b', {name: 'beta'}), bg('c', {name: 'gamma'})]);
    await h.start();
    for (const n of ['beta', 'gamma', 'alpha', 'beta']) {
      await h.select(n);
      await h.keys('Enter');
      await h.waitFor(/fake claude attached/);
      await h.keys('C-q', 'C-l');
      await h.waitFor(new RegExp(`^> ${n}`, 'm'));
    }
    await h.select('gamma');
    const before = h
      .lines()
      .filter(l => /alpha|beta|gamma/.test(l))
      .map(l => l.slice(2));
    await h.keys('q');
    await h.waitFor(/\[exit 0\]/);
    await h.start();
    const after = h.lines().filter(l => /alpha|beta|gamma/.test(l));
    expect(after.map(l => l.slice(2))).toEqual(before);
    expect(after[0]).toMatch(/^> beta/);
  });

  it('10: 行がないときはメッセージ、--json を読めないときはエラーを出し古い一覧を出さない', async () => {
    h = new Harness();
    await h.start();
    expect(h.screen()).toMatch(/No sessions to show/);
    h.agents([bg('a', {name: 'alpha'})]);
    await h.refresh();
    expect(h.screen()).toMatch(/alpha/);
    h.conf({agentsFail: true});
    await h.keys('r');
    await h.waitFor(/Could not read claude agents --json/);
    expect(h.screen()).not.toMatch(/alpha/);
    h.conf({});
    await h.refresh();
    expect(h.screen()).toMatch(/alpha/);
  });

  it('10・51: エラーを出している間は行への操作を受け付けず、読めなかった回のあとも消えた行の Ctrl+X の守りが働く', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'}), bg('b', {name: 'beta', state: 'working', status: 'busy'})]);
    await h.start();
    await h.select('alpha');
    h.conf({agentsFail: true});
    await h.keys('r');
    await h.waitFor(/Could not read claude agents --json/);
    await h.keys('C-x', 'e', 'Enter');
    await sleep(500);
    expect(h.calls().some(c => c.args[0] === 'stop' || c.args[0] === 'attach')).toBe(false);
    expect(h.screen()).not.toMatch(/Note for/);
    // 読めない間に選んでいた行が消え、次に読めた
    h.remove('alpha');
    h.conf({});
    await h.refresh();
    expect(h.screen()).toMatch(/^> beta/m);
    await h.keys('C-x');
    await h.waitFor(/Ctrl\+X ignored: alpha left the list and the selection moved\./);
    expect(h.calls().some(c => c.args[0] === 'stop')).toBe(false);
  });

  it('62・5: attach して戻ると区切りの先頭に上がり、カーソルが付く。段が変わっても並びは変わらない', async () => {
    h = new Harness();
    const app = h.repo('app');
    h.agents([
      bg('a', {cwd: app, name: 'alpha'}),
      bg('b', {cwd: app, name: 'beta'}),
      bg('c', {cwd: app, name: 'gamma'}),
    ]);
    await h.start();
    // 初めて見た時刻が同じなので名前の順
    expect(h.lines().filter(l => /alpha|beta|gamma/.test(l))).toEqual([
      expect.stringMatching(/^> alpha/),
      expect.stringMatching(/^ {2}beta/),
      expect.stringMatching(/^ {2}gamma/),
    ]);
    await h.select('gamma');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    await h.keys('C-q', 'C-l');
    await h.waitFor(/^> gamma/m);
    h.update('alpha', {state: 'working', status: 'busy'});
    await h.refresh();
    const rows = h.lines().filter(l => /alpha|beta|gamma/.test(l));
    expect(rows[0]).toMatch(/^> gamma/);
    expect(rows[1]).toMatch(/alpha +Working/);
    // 新しく見えたセッションは区切りの先頭に出る
    h.agents([...h.readAgents(), bg('d', {cwd: app, name: 'delta'})]);
    await h.refresh();
    expect(h.lines().filter(l => /alpha|beta|gamma|delta/.test(l))[0]).toMatch(/delta/);
    // カーソルは選んでいた行に付いていく
    expect(h.screen()).toMatch(/^> gamma/m);
  });

  it('24: 収まらないときは選んだ行が見えるようにスクロールし、通し番号が出る', async () => {
    h = new Harness();
    const app = h.repo('app');
    h.agents(
      Array.from({length: 25}, (_, i) =>
        bg(`s${String(i).padStart(2, '0')}`, {cwd: app, name: `session-${String(i).padStart(2, '0')}`}),
      ),
    );
    await h.start({size: {cols: 100, rows: 14}});
    for (let i = 0; i < 20; i++) await h.keys('Down');
    const s = h.screen();
    expect(s).toMatch(/^> session-20/m);
    expect(s).toMatch(/^21\/25$/m);
    expect(h.lines()[0]).toMatch(/SESSION/);
  });

  it('4: 同じ sessionId の2行は1行にまとまり、interactive の idle は出ない', async () => {
    h = new Harness();
    h.agents([
      bg('dup', {name: 'dup', state: 'stopped', pid: undefined, status: undefined}),
      tty('dup', {name: 'dup', status: 'waiting', waitingFor: 'permission prompt'}),
      tty('idle', {name: 'idle-tty', status: 'idle', waitingFor: undefined}),
      bg('gone', {name: 'blocked-nopid', state: 'blocked', pid: undefined, status: undefined}),
    ]);
    await h.start();
    const s = h.screen();
    expect(s.match(/dup/g)?.length).toBe(1);
    expect(s).toMatch(/dup \(tty\) +Permission/);
    expect(s).not.toMatch(/idle-tty/);
    expect(s).toMatch(/blocked-nopid +Failed/);
  });
});

describe('attach', () => {
  it('6・27: Enter で attach し、ctrl+q ctrl+l で戻る。次の Enter は attach し直さない。← と Ctrl+Z と /exit でも戻る', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    await h.start();
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to a0000000/);
    expect(h.screen()).toMatch(/\^Q\^L back · \^Q\^W workbench/);
    await h.keys('C-q', 'C-l');
    await h.waitFor(/^> alpha/m);
    const attaches = () => h.calls().filter(c => c.args[0] === 'attach').length;
    expect(attaches()).toBe(1);
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    expect(attaches()).toBe(1);
    // ← は attach を畳み、次の Enter で attach し直す
    await h.keys('Left');
    await h.waitFor(/^> alpha/m);
    await sleep(300);
    expect(h.sessions()).not.toContain('a0000000');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    expect(attaches()).toBe(2);
    await h.keys('C-z');
    await h.waitFor(/^> alpha/m);
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    await h.type('/exit');
    await h.keys('Enter');
    await h.waitFor(/^> alpha/m);
    expect(attaches()).toBe(3);
  });

  it('6: attach が 0 以外で終わると、子のメッセージを残してキーを待ってから一覧に戻る。端末に子の設定が残らない', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    h.conf({attachFail: ['a0000000']});
    await h.start();
    await h.keys('Enter');
    await h.waitFor(/Couldn't attach a0000000/);
    await sleep(500);
    expect(h.screen()).toMatch(/Couldn't attach/);
    await h.keys('x');
    await h.waitFor(/^> alpha/m);
    // マウスの追跡が残っていない(外側の端末の代わりの tmux のペインのモード)
    const mouse = h.inner('display', '-p', '-t', '=list:', '#{mouse_any_flag}#{alternate_on}');
    expect(mouse.trim().startsWith('0')).toBe(true);
  });

  it('7: interactive の行で Enter を押すと、attach せずに cwd と pid が出る', async () => {
    h = new Harness();
    const d = h.mkdir('play');
    h.agents([tty('q', {name: 'poke', cwd: d, pid: 4242})]);
    await h.start();
    await h.keys('Enter');
    await h.waitFor(new RegExp(`poke runs in ${d} \\(pid 4242\\)`));
    expect(h.calls().some(c => c.args[0] === 'attach')).toBe(false);
  });

  it('49: claude の画面の下に、名前と最初の依頼、キーの説明が出る', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    h.transcript(sid('a'), [
      {
        type: 'user',
        message: {role: 'user', content: 'ログインの不具合を直して'},
        timestamp: '2026-10-25T00:00:00.000Z',
      },
    ]);
    await h.start();
    await h.keys('Enter');
    const s = await h.waitFor(/alpha · ログインの不具合を直して/);
    expect(s).toMatch(/\^Q\^L back/);
  });
});

describe('メモ', () => {
  it('15・65: e でメモを付け、直し、消す。行は動かず、終了して起動し直しても残る', async () => {
    h = new Harness();
    const app = h.repo('app');
    h.agents([
      bg('a', {cwd: app, name: 'alpha'}),
      bg('b', {cwd: app, name: 'beta'}),
      tty('q', {cwd: app, name: 'poke'}),
    ]);
    await h.start();
    await h.select('beta');
    await h.keys('e');
    await h.waitFor(/Note for beta: █/);
    // 入力欄はその行の直下に出る
    const ls = h.lines();
    expect(ls[ls.findIndex(l => /^> beta/.test(l)) + 1]).toMatch(/^ {4}Note for beta: █/);
    await h.type('素材待ち');
    await h.keys('Enter');
    await h.waitFor(/↳ 素材待ち/);
    const rows = h.lines().filter(l => /^[> ] /.test(l) && /alpha|beta|poke|↳/.test(l));
    expect(rows).toEqual([
      expect.stringMatching(/^ {2}alpha/),
      expect.stringMatching(/^> beta/),
      expect.stringMatching(/^ {4}↳ 素材待ち/),
      expect.stringMatching(/^ {2}poke \(tty\)/),
    ]);
    expect(h.screen()).not.toMatch(/beta \(/);
    // Esc は何も変えない
    await h.keys('e');
    await h.waitFor(/Note for beta: 素材待ち█/);
    await h.keys('Escape');
    await h.waitFor(s => !/Note for/.test(s) && /↳ 素材待ち/.test(s));
    // 直す
    await h.keys('e', 'C-u');
    await h.type('Bob の返事待ち');
    await h.keys('Enter');
    await h.waitFor(/↳ Bob の返事待ち/);
    // 対話セッションにも付けられる
    await h.select('poke');
    await h.keys('e');
    await h.type('tty note');
    await h.keys('Enter');
    await h.waitFor(/↳ tty note/);
    // idle で一覧から外れ、また出ても残る
    h.update('poke', {status: 'idle', waitingFor: undefined});
    await h.refresh();
    expect(h.screen()).not.toMatch(/tty note/);
    h.update('poke', {status: 'waiting', waitingFor: 'input needed'});
    await h.refresh();
    expect(h.screen()).toMatch(/↳ tty note/);
    // 終了して起動し直しても残る
    await h.keys('q');
    await h.waitFor(/\[exit 0\]/);
    await h.start();
    expect(h.screen()).toMatch(/↳ Bob の返事待ち/);
    // 消す
    await h.select('beta');
    await h.keys('e', 'C-u', 'Enter');
    await h.waitFor(s => !/Bob の返事待ち/.test(s.split('\n').slice(0, 10).join('\n')));
    expect(h.state().notes[sid('b')]).toBeUndefined();
  });

  it('15: サイクル8の状態のファイルにある保留の理由はメモとして出る', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'}), bg('b', {name: 'beta'})]);
    h.writeState({
      version: 2,
      holds: {[sid('a')]: '余裕があるとき', [sid('b')]: ''},
      waits: {},
      seen: {},
      view: 'repo',
    });
    await h.start();
    const s = h.screen();
    expect(s).toMatch(/↳ 余裕があるとき/);
    expect(s.match(/↳/g)?.length).toBe(1);
  });
});
