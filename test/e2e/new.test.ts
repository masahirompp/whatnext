import {writeFileSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {escapeRe, Harness, REPO} from './harness.js';

// `whatnext new`(PRODUCT.md「一覧の外からの起動」、シナリオ 90〜96)。build した cli を端末なしで動かし、偽の claude に
// 渡った引数と、一覧の画面を見る。一言、CTX、ダイジェストが実物の claude で出ることは、実機の通しで確かめる。

let h: Harness;
let other: Server | undefined;
afterEach(async () => {
  h?.cleanup();
  if (other) await new Promise(r => other?.close(r));
  other = undefined;
});

const bgCall = () => h.calls().find(c => c.args[0] === '--bg');
const settingsOf = (args: string[] | undefined) => {
  const i = args?.indexOf('--settings') ?? -1;
  return i < 0 ? undefined : JSON.parse(args?.[i + 1] ?? '{}');
};

describe('whatnext new', () => {
  it('90: 一覧が動いている間に端末なしで起動すると、id を出して終了コード 0 で終わり、一覧のリポジトリの区切りに出る', async () => {
    h = new Harness();
    const foo = h.repo('foo');
    await h.start({args: ''});
    const r = await h.runCli(['new', foo, 'テストを直して']);
    expect(r).toEqual({code: 0, stdout: expect.stringMatching(/^[0-9a-f]{8}\n$/), stderr: ''});
    const id = r.stdout.trim();
    const call = bgCall();
    expect(call?.cwd).toBe(foo);
    expect(call?.args.slice(-2)).toEqual(['--', 'テストを直して']);
    // フックと OTel は、動いている一覧の受け口に向く。mod も付く(シナリオ 93)
    const s = settingsOf(call?.args);
    expect(s.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://127.0.0.1:${h.port}`);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain(`:${h.port}/v1/hooks`);
    expect(call?.args[(call?.args.indexOf('--plugin-dir') ?? -1) + 1]).toBe(join(REPO, 'mod'));
    expect(s.env.WHATNEXT_DIGEST_PORT).toBe(String(h.port));
    // mod が受け手を確かめるソケットは、一覧の専用サーバのもの(サーバに問い合わせずに組んだパスで届く)
    expect(s.env.WHATNEXT_DIGEST_SOCKET).toBe(h.inner('display-message', '-p', '#{socket_path}').trim());
    // claude には WHATNEXT_* を渡さない(#363)
    expect(call?.wn).toEqual([]);
    await h.refresh();
    const screen = await h.waitFor(new RegExp(`── foo[\\s\\S]*${escapeRe(id)}`));
    expect(screen).toMatch(new RegExp(`^[> ] ${escapeRe(id)} `, 'm'));
  });

  it('91: 一覧が動いていない間に起動しても同じものが付き、あとで一覧を開くと、そのセッションが出ている', async () => {
    h = new Harness();
    const foo = h.repo('foo');
    const r = await h.runCli(['new', foo, 'テストを直して']);
    expect(r).toEqual({code: 0, stdout: expect.stringMatching(/^[0-9a-f]{8}\n$/), stderr: ''});
    const call = bgCall();
    const s = settingsOf(call?.args);
    expect(s.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://127.0.0.1:${h.port}`);
    expect(call?.args).toContain('--plugin-dir');
    expect(s.env.WHATNEXT_DIGEST_SOCKET).toMatch(new RegExp(`/tmux-\\d+/${escapeRe(h.socket)}$`));
    // 専用の tmux サーバも一覧も起こさない
    expect(h.innerQuiet('list-sessions')).toBe('');
    await h.start({args: ''});
    await h.waitFor(new RegExp(`── foo[\\s\\S]*${escapeRe(r.stdout.trim())}`));
    // あとで開いた一覧の専用サーバは、起動のときに渡したソケットにいる
    expect(h.inner('display-message', '-p', '#{socket_path}').trim()).toBe(s.env.WHATNEXT_DIGEST_SOCKET);
  });

  it('92: リポジトリ名でも起動する。相対パスの既存のディレクトリも受ける', async () => {
    h = new Harness();
    const foo = h.repo('github.com/alice/foo');
    const bar = h.repo('github.com/alice/bar');
    writeFileSync(join(h.dir, 'ghq.txt'), `${foo}\n${bar}\n`);
    expect((await h.runCli(['new', 'foo', 'x'])).code).toBe(0);
    expect((await h.runCli(['new', 'alice/bar', 'x'])).code).toBe(0);
    expect((await h.runCli(['new', '.', 'x'], {cwd: foo})).code).toBe(0);
    expect(
      h
        .calls()
        .filter(c => c.args[0] === '--bg')
        .map(c => c.cwd),
    ).toEqual([foo, bar, foo]);
  });

  it('93: --no-digest の一覧が動いているときも mod を付ける(受けていないので、mod は Haiku を呼ばない)', async () => {
    h = new Harness();
    const foo = h.repo('foo');
    await h.start({args: '--no-digest'});
    expect((await h.runCli(['new', foo, 'x'])).code).toBe(0);
    const call = bgCall();
    expect(call?.args).toContain('--plugin-dir');
    // mod が読む口(一覧のセッションの @wn_digest_port)は、--no-digest の一覧にはない
    const sock = settingsOf(call?.args).env.WHATNEXT_DIGEST_SOCKET;
    expect(sock).toBe(h.inner('display-message', '-p', '#{socket_path}').trim());
    expect(h.inner('show-options', '-t', '=list:', '-qv', '@wn_digest_port').trim()).toBe('');
  });

  it('94: 存在しないディレクトリ、候補にない名前、2つ以上に一致する名前は、理由を出して終了コード 1 で終わり、起動しない', async () => {
    h = new Harness();
    const a = h.repo('github.com/alice/foo');
    const b = h.repo('github.com/bob/foo');
    writeFileSync(join(h.dir, 'ghq.txt'), `${a}\n${b}\n`);
    expect(await h.runCli(['new', '/no/such/dir', 'x'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'whatnext: Not a directory: /no/such/dir\n',
    });
    expect(await h.runCli(['new', 'nope', 'x'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'whatnext: No such repository: nope\n',
    });
    expect(await h.runCli(['new', 'foo', 'x'])).toEqual({
      code: 1,
      stdout: '',
      stderr: `whatnext: Ambiguous: foo\n  ${a}\n  ${b}\n`,
    });
    expect(bgCall()).toBeUndefined();
  });

  it('94: 指示がなければ、使い方を出して終了コード 1 で終わる', async () => {
    h = new Harness();
    const r = await h.runCli(['new', h.repo('foo')]);
    expect(r).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'whatnext: new needs a directory or a repository name, and a prompt.\nUsage: whatnext new <directory|repository> <prompt>\n',
    });
    expect(bgCall()).toBeUndefined();
  });

  it('42: new のあとの --help は、知らないオプションとして使い方を出し、終了コード 2 で終わる(セッションを起動しない)', async () => {
    h = new Harness();
    for (const args of [
      ['new', '--help'],
      ['new', h.repo('foo'), '--help'],
    ]) {
      const r = await h.runCli(args);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^whatnext: unknown option --help\nUsage: whatnext /);
    }
    expect(bgCall()).toBeUndefined();
  });

  it('95: claude の Bash(CLAUDECODE=1)から呼ぶと断り、終了コード 1 で終わる', async () => {
    h = new Harness();
    const r = await h.runCli(['new', h.repo('foo'), 'x'], {env: {CLAUDECODE: '1'}});
    expect(r).toEqual({
      code: 1,
      stdout: '',
      stderr: 'whatnext: whatnext new cannot run inside a Claude Code session. Run it from a shell or a script.\n',
    });
    expect(bgCall()).toBeUndefined();
  });

  it('96: 受け口のポートをほかのプログラムが使っているときは、フックを付けずに起動し、標準エラーにそう出る', async () => {
    h = new Harness();
    const foo = h.repo('foo');
    // ポートを決めるために、失敗する呼び出しを1回流す
    await h.runCli(['new']);
    // 404 の本文に要求のパス(`/v1/whatnext`)を書き戻すサーバ。本文に whatnext を含んでも、一覧とはみなさない
    other = createServer((req, res) => {
      res.writeHead(404, {'content-type': 'text/html; charset=utf-8'});
      res.end(`<pre>Cannot ${req.method} ${req.url}</pre>\n`);
    });
    await new Promise<void>(r => other?.listen(h.port, '127.0.0.1', r));
    const r = await h.runCli(['new', foo, 'x']);
    expect(r).toEqual({
      code: 0,
      stdout: expect.stringMatching(/^[0-9a-f]{8}\n$/),
      stderr: `whatnext: port ${h.port} is used by another program. Started the session without hooks, so the list shows no context size or digest for it.\n`,
    });
    expect(bgCall()?.args).toEqual(['--bg', '--', 'x']);
  });

  it('信頼されていないディレクトリでは、Not trusted を出して終了コード 1 で終わる', async () => {
    h = new Harness();
    const foo = h.repo('foo');
    h.conf({untrusted: [foo]});
    expect(await h.runCli(['new', foo, 'x'])).toEqual({
      code: 1,
      stdout: '',
      stderr: `whatnext: Not trusted: ${foo}. Run claude there once and accept the trust prompt.\n`,
    });
    expect(h.readAgents()).toEqual([]);
  });
});
