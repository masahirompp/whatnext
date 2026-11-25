import {chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import type {RunOptions, RunResult} from '../../lib/input/exec.js';
import type {Occupant} from '../../lib/input/receiver.js';
import {parseArgs} from '../../src/cli/args.js';
import {decideAttachments, locateTmux, socketPathOf} from '../../src/cli/attachments.js';
import {modDir} from '../../src/cli/env.js';
import {claudeEnv, matchRepos, type NewPorts, newSession, newUsageError, resolveTarget} from '../../src/cli/new.js';
import {bgArgs, existingDir, readBgOutput} from '../../src/ops/start.js';

// `whatnext new`(PRODUCT.md「一覧の外からの起動」、シナリオ 90〜97)。外のコマンドと受け口の確かめは口で差し替える。

const root = realpathSync(mkdtempSync(join(tmpdir(), 'wn-new-')));
afterAll(() => rmSync(root, {recursive: true, force: true}));
const dir = (name: string): string => {
  const p = join(root, name);
  mkdirSync(p, {recursive: true});
  return p;
};

interface Call {
  cmd: string;
  args: readonly string[];
  opts?: RunOptions;
}

/** 偽の口。`claude` と `ghq` の結果と、受け口のポートの状態を決めて渡す。 */
function ports(
  o: {
    /** 受け口のポートの状態。配列なら、確かめるたびに先頭から順に答え、最後の値を繰り返す。 */
    occupant?: Occupant | Occupant[];
    claude?: Partial<RunResult>;
    ghq?: string[] | null;
    pe?: NodeJS.ProcessEnv;
    cwd?: string;
    /** tmux の置き場所(見つからないなら null)。 */
    tmux?: string | null;
    /** 組んだパスに、専用サーバのソケットがあるか(既定はある)。 */
    socket?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  let out = '';
  let err = '';
  const tmuxAsked: string[] = [];
  const socketAsked: string[] = [];
  let probes = 0;
  const p: NewPorts = {
    run: async (cmd, args, opts) => {
      calls.push({cmd, args, opts});
      if (cmd === 'ghq') {
        if (!o.ghq) return {code: null, stdout: '', stderr: '', error: 'ENOENT'};
        return {code: 0, stdout: `${o.ghq.join('\n')}\n`, stderr: ''};
      }
      return {
        code: 0,
        stdout: '\x1b[32mbackgrounded\x1b[0m · 1a2b3c4d\n  claude attach 1a2b3c4d    open in this terminal\n',
        stderr: '',
        ...o.claude,
      };
    },
    probe: async () => {
      probes++;
      if (!Array.isArray(o.occupant)) return o.occupant ?? 'whatnext';
      return o.occupant[Math.min(probes, o.occupant.length) - 1];
    },
    findTmux: path => {
      tmuxAsked.push(path);
      return o.tmux === null ? undefined : (o.tmux ?? '/opt/x/bin/tmux');
    },
    socketExists: path => {
      socketAsked.push(path);
      return o.socket ?? true;
    },
    pe: o.pe ?? {PATH: '/nonexistent', HOME: root},
    cwd: o.cwd ?? root,
    home: root,
    out: s => {
      out += s;
    },
    err: s => {
      err += s;
    },
  };
  return {
    p,
    calls,
    tmuxAsked,
    socketAsked,
    probes: () => probes,
    claude: () => calls.find(c => c.cmd === 'claude'),
    out: () => out,
    err: () => err,
  };
}

const ENV = {port: 14318, socket: 'whatnext'};
const settingsOf = (c: Call | undefined) => {
  const i = c?.args.indexOf('--settings') ?? -1;
  return i < 0 ? undefined : JSON.parse(c?.args[i + 1] ?? '{}');
};

describe('whatnext new の引数', () => {
  it('ディレクトリかリポジトリ名と、指示の2つを取る', () => {
    expect(parseArgs(['new', '~/src/foo', 'テストを直して'])).toEqual({
      cmd: 'new',
      target: '~/src/foo',
      prompt: 'テストを直して',
    });
  });

  it('ディレクトリかリポジトリ名は、前後の空白を切って渡す(指示は切らない)', () => {
    expect(parseArgs(['new', ' ~/src/foo\n', ' x '])).toEqual({cmd: 'new', target: '~/src/foo', prompt: ' x '});
  });

  it('new のあとの --help は、知らないオプションにする(指示が --help のセッションを起動しない)', () => {
    expect(parseArgs(['new', '--help'])).toEqual({cmd: 'bad', arg: '--help'});
    expect(parseArgs(['new', '~/src/foo', '--help'])).toEqual({cmd: 'bad', arg: '--help'});
    expect(parseArgs(['new', '--help', 'x'])).toEqual({cmd: 'bad', arg: '--help'});
    // --help を含むだけの指示は、指示として渡す
    expect(parseArgs(['new', 'foo', '--help と打って'])).toEqual({
      cmd: 'new',
      target: 'foo',
      prompt: '--help と打って',
    });
  });

  it('指示がない、空、引数が多いときは、使い方を出す側に振り分ける', () => {
    expect(parseArgs(['new'])).toEqual({cmd: 'new-usage', many: false});
    expect(parseArgs(['new', 'foo'])).toEqual({cmd: 'new-usage', many: false});
    expect(parseArgs(['new', 'foo', '  '])).toEqual({cmd: 'new-usage', many: false});
    expect(parseArgs(['new', '', 'x'])).toEqual({cmd: 'new-usage', many: false});
    // 引数が多いのは、指示を引用符で囲み忘れたとき。別の文言にするために分ける
    expect(parseArgs(['new', 'foo', 'fix', 'the', 'tests'])).toEqual({cmd: 'new-usage', many: true});
    expect(newUsageError(false)).toBe('whatnext: new needs a directory or a repository name, and a prompt.\n');
    expect(newUsageError(true)).toBe('whatnext: new takes the prompt as one argument. Quote the prompt.\n');
  });

  it('new のほかの振り分けは変わらない', () => {
    expect(parseArgs([])).toEqual({cmd: 'list', digest: true});
    expect(parseArgs(['--no-digest'])).toEqual({cmd: 'list', digest: false});
    expect(parseArgs(['workbench'])).toEqual({cmd: 'workbench'});
    expect(parseArgs(['--no-digest', 'new'])).toEqual({cmd: 'bad', arg: 'new'});
    expect(parseArgs(['newx', 'a', 'b'])).toEqual({cmd: 'bad', arg: 'newx'});
  });
});

describe('受け口の状態ごとに付けるもの', () => {
  it('whatnext new: 一覧が動いているときも、動いていないときも、フックと OTel と mod を付ける', () => {
    expect(decideAttachments('whatnext', {who: 'new'})).toEqual({hooks: true, mod: true});
    expect(decideAttachments('free', {who: 'new'})).toEqual({hooks: true, mod: true});
  });

  it('whatnext new: ポートをほかのプログラムが使っているときは、何も付けない', () => {
    expect(decideAttachments('other', {who: 'new'})).toEqual({hooks: false, mod: false});
  });

  it('一覧: 受け口を自分で開けたときだけ付け、mod は --no-digest では付けない(今までどおり)', () => {
    expect(decideAttachments('free', {who: 'list', opened: true, digest: true})).toEqual({hooks: true, mod: true});
    expect(decideAttachments('free', {who: 'list', opened: true, digest: false})).toEqual({hooks: true, mod: false});
    expect(decideAttachments('free', {who: 'list', opened: false, digest: true})).toEqual({hooks: false, mod: false});
    expect(decideAttachments('whatnext', {who: 'list', opened: false, digest: true})).toEqual({
      hooks: false,
      mod: false,
    });
    expect(decideAttachments('other', {who: 'list', opened: false, digest: true})).toEqual({hooks: false, mod: false});
  });

  it('専用サーバのソケットのパスは、TMUX_TMPDIR の実パスと uid とソケット名で組む', () => {
    expect(socketPathOf('whatnext', {TMUX_TMPDIR: root}, 501)).toBe(join(root, 'tmux-501', 'whatnext'));
    expect(socketPathOf('wn-x', {}, 501)).toBe(join(realpathSync('/tmp'), 'tmux-501', 'wn-x'));
    // TMUX_TMPDIR が存在しないディレクトリのとき、tmux は /tmp に置く(tmux 3.8 の #{socket_path} で確かめた)
    expect(socketPathOf('wn-x', {TMUX_TMPDIR: join(root, 'no-such-dir')}, 501)).toBe(
      join(realpathSync('/tmp'), 'tmux-501', 'wn-x'),
    );
  });
});

describe('claude --bg の引数と出力(n と共有する部品)', () => {
  it('指示は -- の後ろに置き、指示がなければ付けない', () => {
    expect(bgArgs({})).toEqual(['--bg']);
    expect(bgArgs({settings: '{}', pluginDir: '/m'})).toEqual(['--bg', '--settings', '{}', '--plugin-dir', '/m']);
    expect(bgArgs({settings: '{}'}, '--help と打って')).toEqual(['--bg', '--settings', '{}', '--', '--help と打って']);
  });

  it('出力から id、信頼されていないこと、失敗を読む', () => {
    expect(readBgOutput('\x1b[32mbackgrounded\x1b[0m · 0a1b2c3d · x\n', '')).toEqual({k: 'started', id: '0a1b2c3d'});
    expect(readBgOutput('', 'Workspace not trusted. Run claude in /x once\n').k).toBe('untrusted');
    expect(readBgOutput('something went wrong\n', '')).toEqual({k: 'failed', out: 'something went wrong\n'});
  });

  it('信頼の確認のあとのやり直し(n)では、信頼の文言を見ず、id があれば起動できたと読む', () => {
    const untrusted = 'Workspace not trusted. Run claude in /x once and accept the trust prompt, then retry.\n';
    const started = '\x1b[32mbackgrounded\x1b[0m · 0a1b2c3d · x\n';
    // 最初の起動: 文言があれば、id があっても信頼の確認に進む
    expect(readBgOutput(untrusted + started, '').k).toBe('untrusted');
    expect(readBgOutput(started, untrusted).k).toBe('untrusted');
    // やり直し: id があれば起動できた。なければ失敗(信頼の確認は繰り返さない)
    expect(readBgOutput(untrusted + started, '', {afterTrust: true})).toEqual({k: 'started', id: '0a1b2c3d'});
    expect(readBgOutput(started, untrusted, {afterTrust: true})).toEqual({k: 'started', id: '0a1b2c3d'});
    expect(readBgOutput(untrusted, '', {afterTrust: true})).toEqual({k: 'failed', out: untrusted});
  });

  it('既存のディレクトリ: ~ を展開し、相対パスは base があるときだけ受ける', () => {
    const d = dir('exist/sub');
    expect(existingDir(`${d}/`, root)).toBe(d);
    expect(existingDir('~/exist/sub', root)).toBe(d);
    expect(existingDir('~', root)).toBe(root);
    expect(existingDir('exist/sub', root)).toBeUndefined();
    expect(existingDir('exist/sub', root, root)).toBe(d);
    expect(existingDir(join(root, 'nope'), root)).toBeUndefined();
  });
});

describe('whatnext new のディレクトリの解決(シナリオ 92、94)', () => {
  const ghq = [
    '/g/github.com/alice/foo',
    '/g/github.com/bob/foo',
    '/g/github.com/alice/bar',
    '/g/github.com/alice/xfoo',
  ];

  it('名前は、パスの区切りの単位で末尾に一致させる', () => {
    expect(matchRepos(ghq, 'bar')).toEqual(['/g/github.com/alice/bar']);
    expect(matchRepos(ghq, 'foo')).toEqual(['/g/github.com/alice/foo', '/g/github.com/bob/foo']);
    expect(matchRepos(ghq, 'bob/foo')).toEqual(['/g/github.com/bob/foo']);
    expect(matchRepos(ghq, 'github.com/alice/foo')).toEqual(['/g/github.com/alice/foo']);
    expect(matchRepos(ghq, 'foo/')).toEqual(['/g/github.com/alice/foo', '/g/github.com/bob/foo']);
    expect(matchRepos(ghq, 'oo')).toEqual([]);
    expect(matchRepos(ghq, '')).toEqual([]);
  });

  it('既存のディレクトリが先で、ghq は呼ばない', async () => {
    const d = dir('src/foo');
    const t = ports({ghq});
    expect(await resolveTarget('~/src/foo', t.p)).toEqual({dir: d});
    expect(await resolveTarget(d, t.p)).toEqual({dir: d});
    expect(await resolveTarget('src/foo', t.p)).toEqual({dir: d});
    expect(t.calls).toEqual([]);
  });

  it('ディレクトリでなければ、ghq のリポジトリを名前で探す', async () => {
    expect(await resolveTarget('bar', ports({ghq}).p)).toEqual({dir: '/g/github.com/alice/bar'});
    expect(await resolveTarget('bob/foo', ports({ghq}).p)).toEqual({dir: '/g/github.com/bob/foo'});
  });

  it('候補にない名前は No such repository、2件以上は Ambiguous と候補のパス', async () => {
    expect(await resolveTarget('nope', ports({ghq}).p)).toEqual({error: ['No such repository: nope']});
    expect(await resolveTarget('foo', ports({ghq}).p)).toEqual({
      error: ['Ambiguous: foo', '  /g/github.com/alice/foo', '  /g/github.com/bob/foo'],
    });
  });

  it('パスとして書いた引数は、リポジトリ名として探さない', async () => {
    for (const arg of [join(root, 'nope'), '~/nope', '~nobody/nope', '~nobody', './nope', '../nope']) {
      const t = ports({ghq});
      expect(await resolveTarget(arg, t.p)).toEqual({error: [`Not a directory: ${arg}`]});
      expect(t.calls).toEqual([]);
    }
  });

  it('ghq が無い、または失敗したときは、パスだけを受ける', async () => {
    const d = dir('src/baz');
    expect(await resolveTarget(d, ports({ghq: null}).p)).toEqual({dir: d});
    expect(await resolveTarget('baz', ports({ghq: null}).p)).toEqual({
      error: ['Not a directory: baz (repository names need ghq, and "ghq list -p" failed)'],
    });
  });
});

describe('whatnext new の起動', () => {
  it('90: 一覧が動いているとき、n と同じ引数に指示を足して起動し、id だけを標準出力に出す', async () => {
    const d = dir('src/app');
    const t = ports({occupant: 'whatnext'});
    expect(await newSession(ENV, {target: d, prompt: 'テストを直して'}, t.p)).toBe(0);
    expect(t.out()).toBe('1a2b3c4d\n');
    expect(t.err()).toBe('');
    const c = t.claude();
    expect(c?.opts?.cwd).toBe(d);
    expect(c?.args[0]).toBe('--bg');
    expect(c?.args.slice(-2)).toEqual(['--', 'テストを直して']);
    const s = settingsOf(c);
    expect(s.hooks.Stop[0].hooks[0].command).toContain('http://127.0.0.1:14318/v1/hooks');
    expect(s.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:14318');
  });

  it('93: 一覧が動いているとき、mod と、mod が受け手を確かめるための環境を付ける', async () => {
    const t = ports({occupant: 'whatnext', pe: {PATH: '/nonexistent', TMUX_TMPDIR: root}});
    await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, t.p);
    const c = t.claude();
    expect(c?.args[(c?.args.indexOf('--plugin-dir') ?? -1) + 1]).toBe(modDir());
    const env = settingsOf(c).env;
    expect(env.WHATNEXT_DIGEST_PORT).toBe('14318');
    expect(env.WHATNEXT_DIGEST_SOCKET).toBe(join(root, `tmux-${process.getuid?.()}`, 'whatnext'));
    // tmux は、呼ぶ側の環境(`pe`)の PATH から探した絶対パスで渡す
    expect(t.tmuxAsked).toEqual(['/nonexistent']);
    expect(env.WHATNEXT_DIGEST_TMUX).toBe('/opt/x/bin/tmux');
    expect(t.err()).toBe('');
  });

  it('tmux が見つからないときは、素の tmux を渡して起動し、ダイジェストが出ないかもしれないと標準エラーで知らせる', async () => {
    const t = ports({occupant: 'free', tmux: null});
    expect(await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, t.p)).toBe(0);
    expect(settingsOf(t.claude()).env.WHATNEXT_DIGEST_TMUX).toBe('tmux');
    expect(t.claude()?.args).toContain('--plugin-dir');
    expect(t.out()).toBe('1a2b3c4d\n');
    expect(t.err()).toBe(
      'whatnext: tmux not found on PATH. Started the session, but its digest shows in the list only if the session can run tmux.\n',
    );
    // mod を付けないとき(ポートをほかのプログラムが使っている)は、tmux を探さず、知らせもしない
    const other = ports({occupant: 'other', tmux: null});
    await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, other.p);
    expect(other.tmuxAsked).toEqual([]);
    expect(other.err()).not.toContain('tmux');
  });

  it('一覧が動いているのに、組んだパスに専用サーバのソケットが無いときは、起動して、ダイジェストが出ないと標準エラーで知らせる', async () => {
    const pe = {PATH: '/nonexistent', TMUX_TMPDIR: root};
    const sock = join(root, `tmux-${process.getuid?.()}`, 'whatnext');
    const t = ports({occupant: 'whatnext', socket: false, pe});
    expect(await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, t.p)).toBe(0);
    expect(t.socketAsked).toEqual([sock]);
    // 起動は変えない(mod も、組んだパスも付ける。あとでそのパスに一覧が開けば届く)
    expect(t.claude()?.args).toContain('--plugin-dir');
    expect(settingsOf(t.claude()).env.WHATNEXT_DIGEST_SOCKET).toBe(sock);
    expect(t.out()).toBe('1a2b3c4d\n');
    expect(t.err()).toBe(
      `whatnext: the list is running, but its tmux socket is not at ${sock}. Started the session, but its digest will not show in the list. Check that TMUX_TMPDIR here matches the list's terminal.\n`,
    );
    // 一覧が動いていないとき(ポートが空いている)は、ソケットが無いのが普通なので、確かめず、知らせない
    const free = ports({occupant: 'free', socket: false, pe});
    expect(await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, free.p)).toBe(0);
    expect(free.socketAsked).toEqual([]);
    expect(free.err()).toBe('');
    // ポートをほかのプログラムが使っているときも、確かめない(mod を付けない)
    const other = ports({occupant: 'other', socket: false, pe});
    await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, other.p);
    expect(other.socketAsked).toEqual([]);
    expect(other.err()).not.toContain('TMUX_TMPDIR');
    // 起動に失敗したときは、失敗の理由だけを出す
    const failed = ports({occupant: 'whatnext', socket: false, pe, claude: {code: 1, stdout: 'boom\n'}});
    expect(await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, failed.p)).toBe(1);
    expect(failed.err()).not.toContain('TMUX_TMPDIR');
  });

  it('tmux は PATH を先に、なければよくある置き場所を探す(ランチャーの PATH に tmux が無くても見つける)', () => {
    const a = dir('tmux-a');
    const b = dir('tmux-b');
    for (const d of [a, b]) {
      writeFileSync(join(d, 'tmux'), '#!/bin/sh\n');
      chmodSync(join(d, 'tmux'), 0o755);
    }
    const none = dir('tmux-none');
    writeFileSync(join(none, 'tmux'), 'not executable');
    chmodSync(join(none, 'tmux'), 0o644);
    expect(locateTmux(`${none}::${a}`, [b])).toBe(join(a, 'tmux'));
    expect(locateTmux(none, [join(root, 'nope'), b])).toBe(join(b, 'tmux'));
    expect(locateTmux(none)).toBeUndefined();
    expect(locateTmux('', [])).toBeUndefined();
  });

  it('91: 一覧が動いていないときも、同じものを付けて起動する', async () => {
    const live = ports({occupant: 'whatnext'});
    const free = ports({occupant: 'free'});
    const d = dir('src/app');
    expect(await newSession(ENV, {target: d, prompt: 'x'}, free.p)).toBe(0);
    await newSession(ENV, {target: d, prompt: 'x'}, live.p);
    expect(free.claude()?.args).toEqual(live.claude()?.args);
    expect(free.claude()?.args).toContain('--plugin-dir');
    expect(free.out()).toBe('1a2b3c4d\n');
    expect(free.err()).toBe('');
  });

  it('96: ポートをほかのプログラムが使っているときは、何も付けずに起動し、標準エラーに理由を1行出す', async () => {
    const t = ports({occupant: 'other'});
    expect(await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, t.p)).toBe(0);
    expect(t.claude()?.args).toEqual(['--bg', '--', 'x']);
    expect(t.out()).toBe('1a2b3c4d\n');
    expect(t.err()).toBe(
      'whatnext: port 14318 is used by another program. Started the session without hooks, so the list shows no context size or digest for it.\n',
    );
  });

  it('一覧の応答が1回遅れて other と読めても、確かめ直して、フックと OTel と mod を付ける', async () => {
    const t = ports({occupant: ['other', 'whatnext']});
    expect(await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, t.p)).toBe(0);
    expect(t.probes()).toBe(2);
    expect(settingsOf(t.claude()).env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:14318');
    expect(t.claude()?.args).toContain('--plugin-dir');
    expect(t.err()).toBe('');
    // 2回とも other なら、ほかのプログラムとみなす。other でなければ、確かめ直さない
    const other = ports({occupant: 'other'});
    await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, other.p);
    expect(other.probes()).toBe(2);
    expect(other.claude()?.args).toEqual(['--bg', '--', 'x']);
    const free = ports({occupant: 'free'});
    await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, free.p);
    expect(free.probes()).toBe(1);
  });

  it('92: リポジトリ名でも起動する', async () => {
    const d = dir('ghq/github.com/alice/foo');
    const t = ports({ghq: [d, dir('ghq/github.com/alice/bar')]});
    expect(await newSession(ENV, {target: 'foo', prompt: 'x'}, t.p)).toBe(0);
    expect(t.claude()?.opts?.cwd).toBe(d);
    expect(t.out()).toBe('1a2b3c4d\n');
  });

  it('94: ディレクトリが決まらなければ、理由を出して終了コード 1 で終わり、起動しない', async () => {
    const ghq = ['/g/github.com/alice/foo', '/g/github.com/bob/foo'];
    const none = ports({ghq});
    expect(await newSession(ENV, {target: 'nope', prompt: 'x'}, none.p)).toBe(1);
    expect(none.err()).toBe('whatnext: No such repository: nope\n');
    const many = ports({ghq});
    expect(await newSession(ENV, {target: 'foo', prompt: 'x'}, many.p)).toBe(1);
    expect(many.err()).toBe('whatnext: Ambiguous: foo\n  /g/github.com/alice/foo\n  /g/github.com/bob/foo\n');
    const path = ports({ghq});
    expect(await newSession(ENV, {target: '/nonexistent/x', prompt: 'x'}, path.p)).toBe(1);
    expect(path.err()).toBe('whatnext: Not a directory: /nonexistent/x\n');
    for (const t of [none, many, path]) {
      expect(t.claude()).toBeUndefined();
      expect(t.out()).toBe('');
    }
  });

  it('95: claude の Bash(CLAUDECODE=1)からは断り、何も起動しない', async () => {
    const t = ports({pe: {CLAUDECODE: '1'}});
    expect(await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, t.p)).toBe(1);
    expect(t.err()).toBe(
      'whatnext: whatnext new cannot run inside a Claude Code session. Run it from a shell or a script.\n',
    );
    expect(t.calls).toEqual([]);
    expect(t.out()).toBe('');
  });

  it('信頼されていないディレクトリでは、Not trusted を出して終了コード 1 で終わる(信頼の確認は出さない)', async () => {
    const d = dir('src/untrusted');
    const t = ports({claude: {code: 1, stdout: `Workspace not trusted. Run claude in ${d} once\n`}});
    expect(await newSession(ENV, {target: d, prompt: 'x'}, t.p)).toBe(1);
    expect(t.err()).toBe(`whatnext: Not trusted: ${d}. Run claude there once and accept the trust prompt.\n`);
    expect(t.out()).toBe('');
    expect(t.calls.filter(c => c.cmd === 'claude').length).toBe(1);
  });

  it('claude が id を返さなかったとき、起動できなかったときは、その出力を出して終了コード 1 で終わる', async () => {
    const noId = ports({claude: {stdout: 'something went wrong\n'}});
    expect(await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, noId.p)).toBe(1);
    expect(noId.err()).toBe('whatnext: claude --bg did not start a session:\nsomething went wrong\n');
    const enoent = ports({claude: {code: null, stdout: '', error: 'ENOENT'}});
    expect(await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, enoent.p)).toBe(1);
    expect(enoent.err()).toContain('claude not found on PATH (ENOENT)');
    expect(enoent.out()).toBe('');
  });

  it('claude に渡す環境から WHATNEXT_* を外す(デーモンが、起こしたプロセスの環境を持ち続ける。#363)', async () => {
    expect(claudeEnv({PATH: '/bin', WHATNEXT_PORT: '1', WHATNEXT_ROLE: 'list', WHATNEXTX: 'keep'})).toEqual({
      PATH: '/bin',
      WHATNEXTX: 'keep',
    });
    // 作業台のシェルの TMUX(専用サーバを指す)と TMUX_PANE も外す(一覧の n が claude に渡す環境と同じ)
    expect(claudeEnv({PATH: '/bin', TMUX: '/tmp/tmux-501/whatnext,1,0', TMUX_PANE: '%3', TMUX_TMPDIR: '/t'})).toEqual({
      PATH: '/bin',
      TMUX_TMPDIR: '/t',
    });
    const t = ports({pe: {PATH: '/bin', WHATNEXT_PORT: '15000', WHATNEXT_TMUX_SOCKET: 's', WHATNEXT_DIGEST: '0'}});
    await newSession(ENV, {target: dir('src/app'), prompt: 'x'}, t.p);
    expect(Object.keys(t.claude()?.opts?.env ?? {})).toEqual(['PATH']);
  });
});
