import {afterEach, describe, expect, it} from 'vitest';
import {bg, Harness, sid, tty} from './harness.js';

// 依存(待ち先と起動された行)。PRODUCT.md「依存（待ち先と起動された行）」。

let h: Harness;
afterEach(() => h?.cleanup());

const rowsOf = (s: string) => s.split('\n').filter(l => /^[> ] [ │├└]*\S/.test(l) && !/SESSION|↳|→|⚙/.test(l));

describe('待ち先', () => {
  it('17・18・19: f の New session で待ち先を起動し、待ち元は Waiting、終わると ↳ done、attach で消える', async () => {
    h = new Harness();
    const app = h.repo('app');
    h.agents([bg('a', {cwd: app, name: 'impl'})]);
    await h.start();
    await h.keys('f');
    await h.waitFor(/impl waits for: █/);
    await h.keys('Enter');
    // 作業ディレクトリの候補の先頭は待ち元のリポジトリ
    const menu = await h.waitFor(/New session in:/);
    const first = menu.split('\n')[menu.split('\n').findIndex(l => /New session in:/.test(l)) + 1];
    expect(first).toMatch(/^> app$/);
    await h.keys('Enter');
    await h.waitFor(/Model for/);
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to/);
    const newId = h.readAgents().find(r => r.cwd === app && r.name !== 'impl')?.id as string;
    expect(newId).toBeTruthy();
    h.update(newId, {state: 'working', status: 'busy', name: 'review'});
    await h.keys('C-q', 'C-l');
    await h.waitFor(/impl +Waiting/);
    expect(rowsOf(h.screen())).toEqual([
      expect.stringMatching(/^ {2}impl +Waiting/),
      expect.stringMatching(/^> └ review +Working/),
    ]);
    // 終わると自分の段に戻り、↳ done
    h.update(newId, {state: 'done', status: 'idle'});
    await h.refresh();
    expect(h.screen()).toMatch(/impl +Review/);
    expect(h.screen()).toMatch(/│ ↳ review done/);
    // 再び稼働すると Waiting に入り、done は消える
    h.update(newId, {state: 'working', status: 'busy'});
    await h.refresh();
    expect(h.screen()).toMatch(/impl +Waiting/);
    expect(h.screen()).not.toMatch(/review done/);
    h.update(newId, {state: 'done', status: 'idle'});
    await h.refresh();
    expect(h.screen()).toMatch(/review done/);
    // 待ち元が自分で権限待ちなら、待ち先を待っていても自分の段
    h.update(newId, {state: 'working', status: 'busy'});
    h.update('impl', {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'});
    await h.refresh();
    expect(h.screen()).toMatch(/impl +Permission/);
    h.update('impl', {state: 'done', status: 'idle', waitingFor: undefined});
    h.update(newId, {state: 'done', status: 'idle'});
    await h.refresh();
    expect(h.screen()).toMatch(/review done/);
    // attach すると消える
    await h.select('impl');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    await h.keys('C-q', 'C-l');
    await h.waitFor(/^> impl/m);
    expect(h.screen()).not.toMatch(/review done/);
  });

  it('20・44・72: 既存のセッションを結び、外す。メニューは一覧と同じ順。一周する行とほかの待ち元の待ち先は並ばない。(tty) は待ち先になれる', async () => {
    h = new Harness();
    const app = h.repo('app');
    const lib = h.repo('lib');
    h.agents([
      bg('a', {cwd: app, name: 'alpha'}),
      bg('b', {cwd: app, name: 'beta', state: 'working', status: 'busy'}),
      bg('c', {cwd: lib, name: 'gamma', state: 'working', status: 'busy'}),
      tty('q', {cwd: lib, name: 'poke'}),
    ]);
    await h.start();
    await h.select('alpha');
    await h.keys('f');
    let s = await h.waitFor(/alpha waits for:/);
    const menu = (x: string) => {
      const ls = x.split('\n');
      const i = ls.findIndex(l => /waits for:/.test(l));
      return ls.slice(
        i + 1,
        ls.findIndex((l, j) => j > i && /Type to filter/.test(l)),
      );
    };
    expect(menu(s)).toEqual([
      '> New session',
      expect.stringMatching(/^ {4}beta {2}Working · app/),
      expect.stringMatching(/^ {4}gamma {2}Working · lib/),
      expect.stringMatching(/^ {4}poke \(tty\) {2}Question · lib/),
    ]);
    // 文字を打つと、絞り込んで最初に当たった既存のセッションを選ぶ
    await h.type('gam');
    s = await h.waitFor(/waits for: gam█/);
    expect(menu(s)).toEqual(['  New session', expect.stringMatching(/^> {3}gamma/)]);
    await h.keys('Enter');
    await h.waitFor(/alpha now waits for gamma/);
    await h.keys('f');
    await h.waitFor(/alpha waits for:/);
    await h.type('poke');
    await h.keys('Enter');
    await h.waitFor(/alpha now waits for poke/);
    expect(rowsOf(h.screen())).toEqual([
      expect.stringMatching(/^> alpha +Waiting/),
      expect.stringMatching(/^ {2}├ (poke \(tty\)|gamma)/),
      expect.stringMatching(/^ {2}└ (poke \(tty\)|gamma)/),
      expect.stringMatching(/^ {2}beta/),
    ]);
    // gamma の WHERE には lib が出る
    expect(h.screen()).toMatch(/gamma +Working +lib/);
    // 待ち先が複数あるときは、全部が終わるまで Waiting
    h.update('gamma', {state: 'done', status: 'idle'});
    await h.refresh();
    expect(h.screen()).toMatch(/alpha +Waiting/);
    h.update('poke', {status: 'idle', waitingFor: undefined});
    await h.refresh();
    expect(h.screen()).toMatch(/alpha +Review/);
    // beta の f のメニューには、alpha の待ち先(gamma)も alpha の祖先も並ばない
    await h.select('beta');
    await h.keys('f');
    s = await h.waitFor(/beta waits for:/);
    expect(menu(s).join('\n')).not.toMatch(/gamma/);
    expect(menu(s).join('\n')).toMatch(/alpha/);
    await h.keys('Escape');
    // gamma を待ち元にすると、alpha は一周するので並ばない
    await h.select('gamma');
    await h.keys('f');
    s = await h.waitFor(/gamma waits for:/);
    expect(menu(s).join('\n')).not.toMatch(/alpha/);
    await h.keys('Escape');
    // 印の付いた待ち先を選ぶと外れる
    await h.select('alpha');
    await h.keys('f');
    s = await h.waitFor(/alpha waits for:/);
    expect(menu(s).join('\n')).toMatch(/✓ gamma/);
    await h.type('gamma');
    await h.keys('Enter');
    await h.waitFor(/alpha no longer waits for gamma/);
    expect(h.state().waits[sid('a')]).toEqual([sid('q')]);
  });

  it('72: (tty) の行で f を押すと断る', async () => {
    h = new Harness();
    h.agents([tty('q', {name: 'poke'})]);
    await h.start();
    await h.keys('f');
    await h.waitFor(/poke is an interactive session\. It can't wait for other sessions\./);
  });

  it('73: done を出している待ち元に新しく結ぶと done が消える。終わっている行を結んでも done は出ず Waiting にもならない', async () => {
    h = new Harness();
    h.agents([
      bg('a', {name: 'alpha'}),
      bg('b', {name: 'beta', state: 'working', status: 'busy'}),
      bg('c', {name: 'gamma', state: 'done'}),
      bg('d', {name: 'delta', state: 'working', status: 'busy'}),
    ]);
    h.writeState({version: 3, notes: {}, waits: {[sid('a')]: [sid('b')]}, seen: {}});
    await h.start();
    h.update('beta', {state: 'done', status: 'idle'});
    await h.refresh();
    expect(h.screen()).toMatch(/↳ beta done/);
    await h.select('alpha');
    await h.keys('f');
    await h.waitFor(/alpha waits for:/);
    await h.type('gamma');
    await h.keys('Enter');
    await h.waitFor(/alpha now waits for gamma/);
    expect(h.screen()).not.toMatch(/done/);
    expect(h.screen()).toMatch(/alpha +Review/);
    await h.keys('f');
    await h.waitFor(/alpha waits for:/);
    await h.type('delta');
    await h.keys('Enter');
    await h.waitFor(/alpha +Waiting/);
  });

  it('21・65: 待ち先にメモを付けても組に残り、待ち元にメモを付けても組は同じ位置に残る', async () => {
    h = new Harness();
    h.agents([
      bg('a', {name: 'alpha', state: 'done'}),
      bg('b', {name: 'beta', state: 'working', status: 'busy'}),
      bg('z', {name: 'zeta'}),
    ]);
    h.writeState({
      version: 3,
      notes: {},
      waits: {[sid('a')]: [sid('b')]},
      seen: {[sid('a')]: {first: 1, attached: 50}, [sid('b')]: {first: 1}, [sid('z')]: {first: 1, attached: 10}},
    });
    await h.start();
    const before = rowsOf(h.screen());
    await h.select('beta');
    await h.keys('e');
    await h.type('レビュー待ち');
    await h.keys('Enter');
    await h.waitFor(/↳ レビュー待ち/);
    await h.select('alpha');
    await h.keys('e');
    await h.type('親のメモ');
    await h.keys('Enter');
    await h.waitFor(/↳ 親のメモ/);
    const s = h.screen();
    expect(rowsOf(s).map(l => l.replace(/^> /, '  '))).toEqual(before.map(l => l.replace(/^> /, '  ')));
    expect(s).toMatch(/^ {2}│ ↳ 親のメモ/m);
    expect(s).toMatch(/^ {6}↳ レビュー待ち/m);
  });

  it('22: 待ち元を消すと待ち先を巻き込むかを聞く。y で消え、N なら待ち元だけ。(tty) の待ち先は並ばない', async () => {
    h = new Harness();
    h.agents([
      bg('a', {name: 'alpha', state: 'done'}),
      bg('b', {name: 'beta', state: 'done'}),
      bg('c', {name: 'gamma', state: 'working', status: 'busy'}),
      tty('q', {name: 'poke'}),
      bg('x', {name: 'xray', state: 'done'}),
      bg('y', {name: 'yank', state: 'done'}),
      bg('w', {name: 'whisky', state: 'done'}),
    ]);
    h.writeState({
      version: 3,
      notes: {},
      waits: {[sid('a')]: [sid('b'), sid('q')], [sid('b')]: [sid('c')], [sid('x')]: [sid('y')], [sid('w')]: [sid('q')]},
      seen: {},
    });
    await h.start();
    await h.select('alpha');
    await h.keys('C-x');
    await h.waitFor(/Stopped alpha/);
    await h.keys('C-x');
    await h.waitFor(/Also delete 2 sessions this one was waiting for\? \(beta, gamma\) \[y\/N\]/);
    await h.keys('y');
    await h.waitFor(s => !/alpha|beta|gamma/.test(s.split('\n').slice(0, 14).join('\n')), 15000);
    expect(h.screen()).toMatch(/poke \(tty\)/);
    expect(
      h
        .calls()
        .filter(c => c.args[0] === 'rm')
        .map(c => c.args[1]),
    ).toEqual(['a0000000', 'b0000000', 'c0000000']);
    // gamma は稼働中だったので、止めてから消した
    expect(
      h
        .calls()
        .filter(c => c.args[0] === 'stop')
        .map(c => c.args[1]),
    ).toContain('c0000000');
    // N なら待ち元だけ
    await h.select('xray');
    await h.keys('C-x');
    await h.waitFor(/Stopped xray/);
    await h.keys('C-x');
    await h.waitFor(/Also delete 1 session .*\(yank\)/);
    await h.keys('n');
    await h.waitFor(s => !/xray/.test(s));
    expect(h.screen()).toMatch(/yank/);
    // 待ち先が対話セッションだけなら、聞かずに待ち元だけを消す
    await h.select('whisky');
    await h.keys('C-x');
    await h.waitFor(/Stopped whisky/);
    await h.keys('C-x');
    await h.waitFor(s => !/whisky/.test(s));
    expect(h.screen()).not.toMatch(/Also delete/);
  });

  it('22: 待ち元が消えなかったときは、待ち先も消さない', async () => {
    h = new Harness();
    h.agents([
      bg('a', {name: 'alpha', state: 'done', _fake: {rm: 'uncommitted'}}),
      bg('b', {name: 'beta', state: 'done'}),
    ]);
    h.writeState({version: 3, notes: {}, waits: {[sid('a')]: [sid('b')]}, seen: {}});
    await h.start();
    await h.select('alpha');
    await h.keys('C-x');
    await h.waitFor(/Stopped alpha/);
    await h.keys('C-x');
    await h.waitFor(/Also delete 1 session/);
    await h.keys('y');
    await h.waitFor(/uncommitted changes/);
    expect(h.screen()).toMatch(/alpha/);
    expect(h.screen()).toMatch(/beta/);
    expect(
      h
        .calls()
        .filter(c => c.args[0] === 'rm')
        .map(c => c.args[1]),
    ).toEqual(['a0000000']);
  });

  it('64: 別のリポジトリの待ち先は待ち元の区切りに入り、その待ち先に attach すると組が先頭に上がる', async () => {
    h = new Harness();
    const app = h.repo('app');
    const lib = h.repo('lib');
    h.agents([
      bg('a', {cwd: app, name: 'fix app'}),
      bg('b', {cwd: lib, name: 'fix lib', state: 'working', status: 'busy'}),
      bg('c', {cwd: app, name: 'other app'}),
      bg('l', {cwd: lib, name: 'lib only'}),
    ]);
    h.writeState({
      version: 3,
      notes: {},
      waits: {[sid('a')]: [sid('b')]},
      seen: {
        [sid('a')]: {first: 1},
        [sid('b')]: {first: 1},
        [sid('c')]: {first: 1, attached: 100},
        [sid('l')]: {first: 1},
      },
    });
    await h.start();
    let s = h.screen();
    const appBlock = s.slice(s.indexOf('── app'), s.indexOf('── lib'));
    expect(rowsOf(appBlock)).toEqual([
      expect.stringMatching(/other app/),
      expect.stringMatching(/fix app +Waiting/),
      expect.stringMatching(/└ fix lib +Working +lib/),
    ]);
    expect(rowsOf(s.slice(s.indexOf('── lib')))).toEqual([expect.stringMatching(/lib only/)]);
    await h.select('fix lib');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    await h.keys('C-q', 'C-l');
    s = await h.waitFor(/^> └ fix lib/m);
    expect(rowsOf(s.slice(s.indexOf('── app'), s.indexOf('── lib')))[0]).toMatch(/fix app/);
  });

  it('74: 木にならない関係は結ばれていないものとして出て、起動しただけではファイルは書き換わらない', async () => {
    h = new Harness();
    h.agents([
      bg('a', {name: 'alpha'}),
      bg('b', {name: 'beta'}),
      bg('c', {name: 'gamma', state: 'working', status: 'busy'}),
      bg('d', {name: 'delta'}),
      bg('e', {name: 'echo'}),
      tty('q', {name: 'poke'}),
      bg('f', {name: 'fox', state: 'working', status: 'busy'}),
      bg('z', {name: 'zulu'}),
      bg('w', {name: 'whisky'}),
    ]);
    const waits = {
      [sid('a')]: [sid('c')],
      [sid('b')]: [sid('c')],
      [sid('d')]: [sid('e')],
      [sid('e')]: [sid('d')],
      [sid('q')]: [sid('f')],
      [sid('w')]: [sid('z')],
    };
    h.writeState({version: 3, notes: {}, waits, seen: {}});
    await h.start();
    const s = h.screen();
    expect(s.replace(/.*zulu.*/g, '')).not.toMatch(/[├└]/);
    expect(s).not.toMatch(/Waiting/);
    expect(h.state().waits).toEqual(waits);
    // 関係のない行が消えても、木にならない関係はファイルから消えない
    h.remove('zulu');
    await h.refresh();
    expect(h.screen()).not.toMatch(/zulu/);
    const {[sid('w')]: _gone, ...rest} = waits;
    expect(h.state().waits).toEqual(rest);
  });
});

describe('起動された行', () => {
  it('67・68: 起動元の下に (sub) で入れ子になり、さらに起動した行はもう一段深い。起動元の段は変わらず、消えても done は出ない', async () => {
    h = new Harness();
    h.agents([
      bg('p', {name: 'orchestrator', state: 'done', pid: 100}),
      tty('s1', {name: 'worker-1', pid: 300, status: 'busy', waitingFor: undefined}),
      tty('s2', {name: 'worker-2', pid: 500, status: 'busy', waitingFor: undefined}),
      tty('t', {name: 'from-shell', pid: 700, status: 'busy', waitingFor: undefined}),
    ]);
    h.procs([
      [300, 200],
      [200, 100],
      [500, 400],
      [400, 300],
      [700, 600],
      [600, 1],
    ]);
    await h.start();
    const s = h.screen();
    expect(rowsOf(s)).toEqual([
      expect.stringMatching(/from-shell \(tty\)|orchestrator/),
      expect.stringMatching(/.*/),
      expect.stringMatching(/.*/),
      expect.stringMatching(/.*/),
    ]);
    expect(s).toMatch(/^[> ] orchestrator +Review/m);
    expect(s).toMatch(/^ {2}└ worker-1 \(sub\) +Working/m);
    expect(s).toMatch(/^ {4}└ worker-2 \(sub\) +Working/m);
    expect(s).toMatch(/^[> ] from-shell \(tty\)/m);
    h.remove('worker-2');
    h.remove('worker-1');
    await h.refresh();
    expect(h.screen()).not.toMatch(/done/);
    expect(h.screen()).toMatch(/orchestrator +Review/);
  });

  it('69: 起動された行では f も e も断り、ほかの行のメニューに並ばない。起動元を消すとき巻き込みを聞かず、残った行は (tty) で出る', async () => {
    h = new Harness();
    h.agents([
      bg('p', {name: 'orchestrator', state: 'done', pid: 100}),
      tty('s', {name: 'worker', pid: 300, status: 'busy', waitingFor: undefined}),
      bg('o', {name: 'other'}),
    ]);
    h.procs([[300, 100]]);
    await h.start();
    await h.select('worker');
    await h.keys('f');
    await h.waitFor(/worker was started by another session\. It can't wait for other sessions\./);
    await h.keys('e');
    await h.waitFor(/worker was started by another session\. It can't have a note\./);
    await h.select('other');
    await h.keys('f');
    const m = await h.waitFor(/other waits for:/);
    expect(m.slice(m.indexOf('other waits for:'))).not.toMatch(/worker/);
    await h.keys('Escape');
    await h.select('orchestrator');
    await h.keys('C-x');
    await h.waitFor(/Stopped orchestrator/);
    // 起動元が止まって pid がなくなり、起動された行の祖先は付け替わった
    h.procs([[300, 1]]);
    await h.keys('C-x');
    await h.waitFor(s => !/orchestrator/.test(s), 10000);
    expect(h.screen()).not.toMatch(/Also delete/);
    await h.refresh();
    expect(h.screen()).toMatch(/^[> ] worker \(tty\)/m);
  });

  it('70: 選んでいた起動された行が消えると起動元に移り、直後の Ctrl+X は受け付けない', async () => {
    h = new Harness();
    h.agents([
      bg('w', {name: 'waiter', state: 'done'}),
      bg('p', {name: 'orchestrator', state: 'working', status: 'busy', pid: 100}),
      tty('s', {name: 'worker', pid: 300, status: 'busy', waitingFor: undefined}),
    ]);
    h.procs([[300, 100]]);
    h.writeState({version: 3, notes: {}, waits: {[sid('w')]: [sid('p')]}, seen: {}});
    await h.start();
    await h.select('worker');
    h.remove('worker');
    await h.refresh();
    expect(h.screen()).toMatch(/^> └ orchestrator/m);
    await h.keys('C-x');
    await h.waitFor(/Ctrl\+X ignored: worker left the list and the selection moved\./);
    expect(h.calls().some(c => c.args[0] === 'stop')).toBe(false);
  });

  it('71: 一覧に出ていない対話セッションが起動した行はトップレベルに (sub) で並び、起動元が出ると入れ子に入る', async () => {
    h = new Harness();
    h.agents([
      tty('q', {name: 'quiet', pid: 100, status: 'idle', waitingFor: undefined}),
      tty('s', {name: 'worker', pid: 300, status: 'busy', waitingFor: undefined}),
    ]);
    h.procs([[300, 100]]);
    await h.start();
    expect(h.screen()).toMatch(/^> worker \(sub\)/m);
    await h.keys('f');
    await h.waitFor(/can't wait for other sessions/);
    await h.keys('e');
    await h.waitFor(/can't have a note/);
    h.update('quiet', {status: 'busy'});
    await h.refresh();
    expect(h.screen()).toMatch(/^[> ] quiet \(tty\) +Working/m);
    expect(h.screen()).toMatch(/^[> ] └ worker \(sub\)/m);
  });

  it('77(単体寄り): MCP_CALLER_PID の行を起動元にする。値がないか一致しない行は (tty) で出る', async () => {
    h = new Harness();
    h.agents([
      bg('p', {name: 'P', pid: 100, state: 'working', status: 'busy'}),
      bg('r', {name: 'R', pid: 200, state: 'working', status: 'busy'}),
      tty('a', {name: 'from-P', pid: 300, status: 'busy', waitingFor: undefined}),
      tty('b', {name: 'from-R', pid: 301, status: 'busy', waitingFor: undefined}),
      tty('c', {name: 'no-header', pid: 302, status: 'busy', waitingFor: undefined}),
    ]);
    h.procs([
      [300, 1],
      [301, 1],
      [302, 1],
    ]);
    h.procEnv([
      '300 claude -p go PATH=/bin MCP_CALLER_PID=100',
      '301 claude -p go PATH=/bin MCP_CALLER_PID=200',
      '302 claude -p go PATH=/bin',
    ]);
    await h.start();
    const s = h.screen();
    expect(s).toMatch(/^[> ] P +Working[\s\S]*?\n {2}└ from-P \(sub\)/m);
    expect(s).toMatch(/^[> ] R +Working[\s\S]*?\n {2}└ from-R \(sub\)/m);
    expect(s).toMatch(/^[> ] no-header \(tty\)/m);
  });
});
