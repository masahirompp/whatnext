import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {run} from '../../lib/input/exec.js';
import {deriveSpawners, parseCallerPids} from '../../src/input/spawners.js';
import {Locations, locate} from '../../src/input/where.js';

const sh = (cwd: string, cmd: string, ...args: string[]) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@x',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@x',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'file',
    },
  }).toString();
const g = (cwd: string, ...args: string[]) => sh(cwd, 'git', ...args);

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'wn-where-')));

describe('場所の問い合わせ', () => {
  it('worktree と根より下は元のリポジトリの区切りに入る(61)', async () => {
    const d = tmp();
    const app = join(d, 'app');
    mkdirSync(join(app, 'pkg', 'web'), {recursive: true});
    g(app, 'init', '-q', '-b', 'main');
    writeFileSync(join(app, 'pkg', 'web', 'f'), 'x');
    g(app, 'add', '.');
    g(app, 'commit', '-qm', 'i');
    g(app, 'worktree', 'add', '-q', '-b', 'fix-login', join(app, '.claude', 'worktrees', 'fix-login'));
    const main = await locate(run, app);
    expect(main).toMatchObject({root: app, repo: true, worktree: false, branch: undefined, sub: undefined});
    const sub = await locate(run, join(app, 'pkg', 'web'));
    expect(sub).toMatchObject({root: app, sub: 'pkg/web'});
    const wt = await locate(run, join(app, '.claude', 'worktrees', 'fix-login'));
    expect(wt).toMatchObject({
      root: app,
      worktree: true,
      branch: 'fix-login',
      checkout: join(app, '.claude', 'worktrees', 'fix-login'),
    });
  });
  it('.bare 型の構成では、根は裸のリポジトリの親になる(75)', async () => {
    const d = tmp();
    const src = join(d, 'src');
    mkdirSync(src);
    g(src, 'init', '-q', '-b', 'main');
    writeFileSync(join(src, 'f'), 'x');
    g(src, 'add', '.');
    g(src, 'commit', '-qm', 'i');
    const foo = join(d, 'foo');
    mkdirSync(foo);
    g(foo, 'clone', '-q', '--bare', src, join(foo, '.bare'));
    g(join(foo, '.bare'), 'worktree', 'add', '-q', join(foo, 'main'), 'main');
    g(join(foo, '.bare'), 'worktree', 'add', '-q', '-b', 'feature', join(foo, 'feature'));
    expect(await locate(run, join(foo, 'main'))).toMatchObject({root: foo, repo: true});
    expect(await locate(run, join(foo, 'feature'))).toMatchObject({root: foo, branch: 'feature'});
  });
  it('submodule の中は親のリポジトリの区切りに入り、submodule のパスが残る(75)', async () => {
    const d = tmp();
    const lib = join(d, 'lib');
    mkdirSync(lib);
    g(lib, 'init', '-q', '-b', 'main');
    writeFileSync(join(lib, 'f'), 'x');
    g(lib, 'add', '.');
    g(lib, 'commit', '-qm', 'i');
    const app = join(d, 'app');
    mkdirSync(app);
    g(app, 'init', '-q', '-b', 'main');
    g(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
    const loc = await locate(run, join(app, 'vendor', 'lib'));
    expect(loc).toMatchObject({root: app, repo: true, sub: 'vendor/lib'});
  });
  it('git でない場所はパスそのものが区切りになる(63)', async () => {
    const d = tmp();
    expect(await locate(run, d)).toMatchObject({root: d, repo: false});
  });
  it('前回リポジトリだった場所が一度だけ失敗しても、前回の場所を使う', async () => {
    let fail = false;
    const fake: typeof run = async (cmd, args, opts) =>
      fail ? {code: 128, stdout: '', stderr: 'fatal'} : run(cmd, args, opts);
    const d = tmp();
    g(d, 'init', '-q', '-b', 'main');
    const ls = new Locations(fake);
    await ls.refresh([d]);
    expect(ls.get(d)?.repo).toBe(true);
    fail = true;
    await ls.refresh([d]);
    expect(ls.get(d)?.repo).toBe(true);
    await ls.refresh([d]);
    expect(ls.get(d)?.repo).toBe(false);
  });
});

describe('起動元の導き方(67、71、77)', () => {
  const none = async () => new Map<number, number | null>();
  it('祖先をたどって最初に当たった別の行を起動元にする', async () => {
    const rows = [
      {sid: 'P', kind: 'background', pid: 10},
      {sid: 'S1', kind: 'interactive', pid: 30},
      {sid: 'S2', kind: 'interactive', pid: 50},
      {sid: 'T', kind: 'interactive', pid: 70},
    ];
    const parents = new Map([
      [30, 20],
      [20, 10],
      [10, 5],
      [50, 40],
      [40, 30],
      [70, 60],
      [60, 1],
    ]);
    const m = await deriveSpawners(rows, {parents, prev: new Map(), callerPid: none});
    expect([...m]).toEqual([
      ['S1', 'P'],
      ['S2', 'S1'],
    ]);
  });
  it('background の行は起動された行にしない', async () => {
    const rows = [
      {sid: 'P', kind: 'background', pid: 10},
      {sid: 'B', kind: 'background', pid: 30},
    ];
    const m = await deriveSpawners(rows, {parents: new Map([[30, 10]]), prev: new Map(), callerPid: none});
    expect(m.size).toBe(0);
  });
  it('祖先から分からないときは MCP_CALLER_PID の行を起動元にする。祖先から分かるときは祖先を優先する', async () => {
    const rows = [
      {sid: 'P', kind: 'background', pid: 10},
      {sid: 'R', kind: 'background', pid: 11},
      {sid: 'S', kind: 'interactive', pid: 30},
      {sid: 'U', kind: 'interactive', pid: 31},
      {sid: 'V', kind: 'interactive', pid: 32},
    ];
    const parents = new Map([
      [30, 1],
      [31, 1],
      [32, 10],
    ]);
    const asked: number[][] = [];
    const callerPid = async (pids: number[]) => {
      asked.push(pids);
      return new Map<number, number | null>([
        [30, 11],
        [31, 999],
        [32, 11],
      ]);
    };
    const m = await deriveSpawners(rows, {parents, prev: new Map(), callerPid});
    expect([...m]).toEqual([
      ['V', 'P'],
      ['S', 'R'],
    ]);
    expect(asked).toEqual([[30, 31]]);
  });
  it('表に pid がない回は、起動元がまだ行に残っていれば持ち越す', async () => {
    const rows = [
      {sid: 'P', kind: 'background', pid: 10},
      {sid: 'S', kind: 'interactive', pid: 30},
    ];
    const m = await deriveSpawners(rows, {parents: new Map(), prev: new Map([['S', 'P']]), callerPid: none});
    expect(m.get('S')).toBe('P');
    const gone = await deriveSpawners([rows[1]], {parents: new Map(), prev: new Map([['S', 'P']]), callerPid: none});
    expect(gone.size).toBe(0);
  });
  it('祖先が付け替わっても、起動元がまだ pid を持てば持ち越し、pid がなくなれば終わる', async () => {
    const rows = [
      {sid: 'P', kind: 'background', pid: 10},
      {sid: 'S', kind: 'interactive', pid: 30},
    ];
    const parents = new Map([[30, 1]]);
    expect((await deriveSpawners(rows, {parents, prev: new Map([['S', 'P']]), callerPid: none})).get('S')).toBe('P');
    const stopped = [{sid: 'P', kind: 'background'}, rows[1]];
    expect((await deriveSpawners(stopped, {parents, prev: new Map([['S', 'P']]), callerPid: none})).size).toBe(0);
  });
  it('ps -E の出力から MCP_CALLER_PID を読む', () => {
    const text = [
      '  301 claude -p hello MCP_CALLER_PID=7 PATH=/bin MCP_CALLER_PID=83244 HOME=/Users/x',
      '  302 claude -p hi PATH=/bin HOME=/Users/x',
      '  303 claude -p XMCP_CALLER_PID=5 PATH=/bin',
    ].join('\n');
    expect([...parseCallerPids(text)]).toEqual([
      [301, 83244],
      [302, null],
      [303, null],
    ]);
  });
});
