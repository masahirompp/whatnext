import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {bg, Harness, sid, sleep, tty} from './harness.js';

// 操作(PRODUCT.md「操作」と「受け入れシナリオ」の新しいセッションの起動、停止と削除、外のアプリで開く)。

let h: Harness;
afterEach(() => h?.cleanup());

const panel = (s: string, title: RegExp) => {
  const ls = s.split('\n');
  const i = ls.findIndex(l => title.test(l));
  return i < 0
    ? []
    : ls.slice(
        i,
        ls.findIndex((l, j) => j > i && l === ''),
      );
};

describe('新しいセッションの起動', () => {
  it('8・43: 候補を絞り込んで選び、モデルを選ぶと起動して attach し、離脱すると一覧に出る。Esc で1つ前に戻る', async () => {
    h = new Harness();
    const app = h.repo('app');
    const other = h.mkdir('elsewhere');
    writeFileSync(join(h.dir, 'ghq.txt'), `${h.repo('ghq-repo')}\n`);
    h.agents([bg('a', {cwd: app, name: 'alpha'})]);
    await h.start({cwd: app});
    await h.keys('n');
    let s = await h.waitFor(/New session in:/);
    expect(panel(s, /New session in:/)).toEqual([
      'New session in: █',
      '> app',
      '  ghq-repo',
      '  Other...',
      'Type to filter · Enter select · Esc close',
    ]);
    // 絞り込み
    await h.type('gr');
    s = await h.waitFor(/New session in: gr█/);
    expect(panel(s, /New session in:/).slice(1, 3)).toEqual(['> ghq-repo', '  Other...']);
    // Other... は打った文字を引き継ぐ。存在しないパスと相対パスは断る
    await h.keys('Down', 'Enter');
    await h.waitFor(/Directory: gr█/);
    await h.keys('Enter');
    await h.waitFor(/Not a directory: gr/);
    await h.keys('C-u');
    for (let i = 0; i < 2; i++) await h.keys('BSpace');
    await h.type('/no/such/dir');
    await h.keys('Enter');
    await h.waitFor(/Not a directory: \/no\/such\/dir/);
    // Esc で候補の選択に戻る
    await h.keys('Escape');
    await h.waitFor(/New session in: █/);
    await h.keys('Down', 'Down', 'Enter');
    await h.waitFor(/Directory: █/);
    await h.type(other);
    await h.keys('Enter');
    await h.waitFor(/Model for .*elsewhere:/);
    // Esc で作業ディレクトリの選択に戻る
    await h.keys('Escape');
    await h.waitFor(/New session in:/);
    await h.keys('Down', 'Down', 'Enter');
    await h.type(other);
    await h.keys('Enter');
    await h.waitFor(/Model for/);
    await h.keys('Down', 'Enter');
    await h.waitFor(/Model: █/);
    await h.keys('Enter');
    expect(h.screen()).toMatch(/Model: █/);
    await h.keys('Escape');
    await h.waitFor(/> Other\.\.\./);
    await h.keys('Enter');
    await h.type('haiku');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to/);
    const bgCall = h.calls().find(c => c.args[0] === '--bg');
    expect(bgCall?.args).toEqual(expect.arrayContaining(['--bg', '--model', 'haiku', '--settings']));
    expect(bgCall?.cwd).toBe(other);
    await h.keys('C-q', 'C-l');
    await h.waitFor(/── elsewhere/);
    expect(h.screen()).toMatch(/^> \S+ +Question \(blocked\)/m);
  });

  it('8: 空のまま Enter を押すと起動したディレクトリで起動する。ghq がなくても候補は出る。起動中は一覧に戻らない', async () => {
    h = new Harness();
    const app = h.repo('app');
    h.conf({bgDelay: 2500});
    await h.start({cwd: app});
    await h.keys('n', 'Down', 'Enter');
    await h.waitFor(/Enter confirm \(empty: .*app\)/);
    await h.keys('Enter');
    await h.waitFor(/Model for .*app/);
    await h.keys('Enter');
    const s = await h.waitFor(/Starting the session\.\.\. \d+s/);
    expect(s).toMatch(/Directory: .*app/);
    expect(s).toMatch(/Model: default/);
    await h.waitFor(/fake claude attached/, 10000);
    expect(h.calls().find(c => c.args[0] === '--bg')?.args).not.toContain('--model');
  });

  it('8: 起動の出力から id を読めないときは、出力を残してキーを待つ', async () => {
    h = new Harness();
    h.conf({bgNoId: true});
    await h.start();
    await h.keys('n', 'Enter', 'Enter');
    await h.waitFor(/claude --bg did not start a session:\nsomething went wrong/);
    await h.keys('x');
    await h.waitFor(s => !/did not start/.test(s));
  });

  it('47: 信頼していないディレクトリでは信頼の確認を出し、信頼すると起動して attach する。断ると Not trusted', async () => {
    h = new Harness();
    const app = h.repo('app');
    const no = h.repo('nope');
    h.conf({untrusted: [app, no]});
    await h.start({cwd: app});
    await h.keys('n', 'Enter', 'Enter');
    await h.waitFor(/Do you trust the files in .*app\?/);
    await h.keys('y');
    await h.waitFor(/fake claude attached/, 10000);
    await h.keys('C-q', 'C-l');
    await h.waitFor(/SESSION/);
    await h.keys('n');
    await h.keys('Down', 'Enter');
    await h.type(no);
    await h.keys('Enter', 'Enter');
    await h.waitFor(/Do you trust the files in .*nope\?/);
    await h.keys('n');
    await h.waitFor(/Not trusted: .*nope/);
  });

  it('17: f の New session で起動した行が直後の --json に出なくても、現れた時点で結ぶ', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'impl'})]);
    h.conf({hideNew: true});
    await h.start();
    await h.keys('f', 'Enter', 'Enter', 'Enter');
    await h.waitFor(/fake claude attached/);
    await h.keys('C-q', 'C-l');
    await h.waitFor(/^> impl/m);
    const hidden = JSON.parse(h.file('hidden.json'));
    h.agents([...h.readAgents(), {...hidden, state: 'working', status: 'busy'}]);
    await h.refresh();
    expect(h.screen()).toMatch(/impl +Waiting/);
    expect(h.state().waits[sid('a')]).toEqual([hidden.sessionId]);
  });
});

describe('停止と削除', () => {
  it('9: Ctrl+X で止め、2秒以内にもう一度で消す。止めている間は Stopping...、消している間は Deleting...', async () => {
    h = new Harness();
    h.agents([
      bg('a', {name: 'alpha', state: 'working', status: 'busy', _fake: {rm: 'lock'}}),
      bg('b', {name: 'beta'}),
    ]);
    await h.start();
    await h.keys('C-x');
    await h.waitFor(/Press Ctrl\+X again within 2s to delete\./);
    expect(h.screen()).toMatch(/alpha +Stopped/);
    await h.keys('C-x');
    // ロックで断られている間も Deleting... のまま待つ
    await h.waitFor(/alpha +Deleting\.\.\./);
    await h.waitFor(s => !/alpha/.test(s), 15000);
    expect(h.calls().filter(c => c.args[0] === 'rm').length).toBe(3);
  });

  it('9: push していないコミットがあれば聞き、y で消す。未コミットの変更があれば断りの文言を出して残る', async () => {
    h = new Harness();
    h.agents([
      bg('a', {name: 'alpha', state: 'stopped', pid: undefined, status: undefined, _fake: {rm: 'unpushed'}}),
      bg('b', {name: 'beta', state: 'stopped', pid: undefined, status: undefined, _fake: {rm: 'uncommitted'}}),
    ]);
    await h.start();
    await h.select('alpha');
    await h.keys('C-x');
    await h.waitFor(/Press Ctrl\+X again/);
    await h.keys('C-x');
    await h.waitFor(/Discard 1 unpushed commit and delete session a0000000\? \[y\/N\]/);
    await h.keys('y');
    await h.waitFor(s => !/alpha/.test(s));
    expect(h.calls().find(c => c.args.includes('--discard-unpushed'))?.args).toEqual([
      'rm',
      'a0000000',
      '--discard-unpushed',
      'abc1234@wt-a0000000',
    ]);
    await sleep(2100);
    await h.select('beta');
    await h.keys('C-x');
    await h.waitFor(/Press Ctrl\+X again/);
    await h.keys('C-x');
    await h.waitFor(/The worktree has uncommitted changes/);
    expect(h.screen()).toMatch(/beta +Stopped/);
  });

  it('40: 止める操作が失敗すると、出力と2回目で削除できることを示す', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha', state: 'working', status: 'busy', _fake: {stopFails: true}})]);
    await h.start();
    await h.keys('C-x');
    await h.waitFor(/Stop failed: could not stop a0000000: daemon busy \(Ctrl\+X again to delete\)/);
    expect(h.screen()).not.toMatch(/Stopped alpha/);
  });

  it('9: 待ち受け中に別のキーを押すと取り消す。Esc でも取り消す。一覧では ctrl+q を無視する', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha', state: 'stopped', pid: undefined, status: undefined}), bg('b', {name: 'beta'})]);
    await h.start();
    await h.select('alpha');
    await h.keys('C-x');
    await h.waitFor(/Press Ctrl\+X again/);
    await h.keys('Down', 'Up', 'C-x');
    await h.waitFor(/Press Ctrl\+X again/);
    expect(h.calls().some(c => c.args[0] === 'rm')).toBe(false);
    await h.keys('Escape', 'C-x');
    await h.waitFor(/Press Ctrl\+X again/);
    await h.keys('C-q', 'C-x');
    await h.waitFor(s => !/alpha/.test(s));
  });

  it('51: 選んでいる行が外で消えてカーソルが移った直後の Ctrl+X は受け付けない', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'}), bg('b', {name: 'beta', state: 'working', status: 'busy'})]);
    await h.start();
    await h.select('alpha');
    h.remove('alpha');
    await h.refresh();
    expect(h.screen()).toMatch(/^> beta/m);
    await h.keys('C-x');
    await h.waitFor(/Ctrl\+X ignored: alpha left the list and the selection moved\./);
    expect(h.calls().some(c => c.args[0] === 'stop')).toBe(false);
    await sleep(2100);
    await h.keys('C-x');
    await h.waitFor(/Stopped beta/);
  });
});

describe('attach している間のキー', () => {
  it('52・53: ctrl+q ctrl+e でメモの入力欄、ctrl+q ctrl+x で止め、続けて消す', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha', state: 'working', status: 'busy'}), bg('b', {name: 'beta'})]);
    await h.start();
    await h.select('alpha');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to a0000000/);
    await h.keys('C-q', 'C-e');
    await h.waitFor(/Note for alpha: █/);
    await h.keys('Escape');
    await h.waitFor(s => !/Note for/.test(s));
    expect(h.screen()).toMatch(/^> alpha/m);
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to a0000000/);
    await h.keys('C-q', 'e');
    await h.waitFor(/Note for alpha:/);
    await h.type('n1');
    await h.keys('Enter');
    await h.waitFor(/↳ n1/);
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to a0000000/);
    await h.keys('C-q', 'C-x');
    await h.waitFor(/alpha +(Stopping\.\.\.|Stopped)/);
    await h.keys('C-q', 'C-x');
    await h.waitFor(s => !/alpha/.test(s));
  });

  it('54・55: ctrl+q ctrl+n で候補の先頭がいたセッションのリポジトリ、ctrl+q ctrl+f でその行の待ち先のメニュー', async () => {
    h = new Harness();
    const app = h.repo('app');
    const lib = h.repo('lib');
    h.agents([bg('a', {cwd: app, name: 'alpha'}), bg('l', {cwd: lib, name: 'libby'})]);
    await h.start({cwd: app});
    await h.select('libby');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to l0000000/);
    await h.keys('C-q', 'C-n');
    const s = await h.waitFor(/New session in:/);
    expect(panel(s, /New session in:/)[1]).toBe('> lib');
    await h.keys('Escape');
    await h.waitFor(s2 => !/New session in/.test(s2) && /^> libby/m.test(s2));
    await h.keys('Enter');
    await h.waitFor(/fake claude attached to l0000000/);
    await h.keys('C-q', 'C-f');
    await h.waitFor(/libby waits for:/);
    await h.keys('Escape');
    await h.waitFor(s2 => !/waits for/.test(s2));
  });

  it('14・48: v で選んだ行の場所を VS Code で開き、attach している間は ctrl+q ctrl+v と ctrl+q v で開く', async () => {
    h = new Harness();
    const app = h.repo('app');
    const plain = h.mkdir('plain');
    mkdirSync(join(app, 'sub'));
    h.agents([bg('a', {cwd: join(app, 'sub'), name: 'alpha'}), tty('q', {cwd: plain, name: 'poke'})]);
    await h.start();
    await h.select('alpha');
    await h.keys('v');
    await h.waitFor(/Opened .*app in VS Code\./);
    expect(h.file('open.log').trim()).toBe(`vscode://file${app}/?windowId=_blank`);
    await h.select('poke');
    await h.keys('v');
    await h.waitFor(/Opened .*plain in VS Code\./);
    await h.select('alpha');
    await h.keys('Enter');
    await h.waitFor(/fake claude attached/);
    await h.keys('C-q', 'C-v');
    await h.waitFor(/Opened .*app in VS Code\./);
    expect(h.screen()).toMatch(/fake claude attached/);
    await h.keys('C-q', 'v');
    await sleep(800);
    expect(h.file('open.log').trim().split('\n').length).toBe(4);
  });
});
