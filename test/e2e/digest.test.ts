import {mkdirSync, writeFileSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {bg, CLI, escapeRe, Harness, REPO, sid, sleep, tty} from './harness.js';

// ダイジェスト(PRODUCT.md「ダイジェスト」)。mod の代わりに、テストが受け口へダイジェストの本文を送る。
// WN_CAPTURE=<ディレクトリ> を付けて流すと、取った画面をそこに書く(見た目の決定に使う)。

let h: Harness;
afterEach(() => h?.cleanup());

const capture = (name: string, screen: string) => {
  const dir = process.env.WN_CAPTURE;
  if (!dir) return;
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, `${name}.txt`), screen);
};

async function post(port: number, body: object): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/v1/hooks`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
}

const digest = (
  id: string,
  r: {goal: string; progress: string; next: string} | null,
  links: [string, string][] = [],
) => ({
  hook_event_name: 'WhatnextDigest',
  session_id: sid(id),
  digest: r,
  links: links.map(([label, href]) => ({label, href})),
});

/** mod から見える、受けているポート(サーバのオプションと、一覧のセッションのオプション)。`socket` は mod に渡すソケット。 */
const live = (socket?: string) => {
  const server = socket ? ['-S', socket] : [];
  return [
    h.inner(...server, 'show-options', '-sqv', '@wn_digest_port').trim(),
    h.inner(...server, 'show-options', '-t', '=list:', '-qv', '@wn_digest_port').trim(),
  ]
    .filter(Boolean)
    .join(',');
};

function rows(app: string, demo: string) {
  return [
    bg('fixlogin', {name: 'fix-login', cwd: app, state: 'done'}),
    bg('refactor', {name: 'refactor the auth middleware', cwd: app, state: 'working', status: 'busy'}),
    bg('demoread', {name: 'demo readme', cwd: demo, state: 'done'}),
    tty('ttyrow', {name: 'scratch', cwd: demo}),
  ];
}

async function sendAll(port: number): Promise<void> {
  await post(
    port,
    digest(
      'fixlogin',
      {
        goal: 'ログイン画面の二重送信を直す',
        progress: '送信ボタンを押下中は無効にし、テストを2件足した。PR #58 を作った。',
        next: 'レビューの指摘を待つ',
      },
      [
        ['PR #58', 'https://github.com/acme/app/pull/58'],
        ['acme/app#412', 'https://github.com/acme/app/issues/412'],
        ['acme/app@3f2a91c', 'https://github.com/acme/app/commit/3f2a91c'],
      ],
    ),
  );
  await post(
    port,
    digest(
      'refactor',
      {
        goal: '認証ミドルウェアをセッション方式からトークン方式へ移す',
        progress: 'ルートの半分を移し終えた。残りは admin 配下。',
        next: 'admin 配下のルートを移す',
      },
      [['acme/infra#77', 'https://github.com/acme/infra/issues/77']],
    ),
  );
  await post(
    port,
    digest('demoread', {goal: 'README.mdの末尾に「hello」の行を追加する', progress: '行を足した', next: ''}),
  );
}

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();

/** 一言の出どころの会話記録(画面の例と同じ一言にする)。 */
function talk(x: Harness): void {
  const said = (id: string, prompt: string, answer: string | undefined, min: number) =>
    x.transcript(sid(id), [
      {type: 'user', message: {role: 'user', content: prompt}, timestamp: ago(min)},
      ...(answer
        ? [
            {
              type: 'assistant',
              message: {role: 'assistant', content: [{type: 'text', text: answer}]},
              timestamp: ago(1),
            },
          ]
        : []),
    ]);
  said('fixlogin', 'ログイン画面の二重送信を直して', '送信中はボタンを無効にして、テストを2件足しました。', 300);
  said('refactor', 'admin 配下のルートも移して', undefined, 42);
  said('demoread', 'README に hello の行を足して', 'README.md に hello の行を足しました。', 3);
}

describe('ダイジェスト', () => {
  it('80・81: --digest で起動すると、届いたダイジェストの Goal が各行の一言の上に、カーソルの行のダイジェストと会話リンクが右の欄に出る', async () => {
    h = new Harness();
    const app = h.repo('app');
    const demo = h.repo('demo');
    h.agents(rows(app, demo));
    talk(h);
    await h.start({args: '--digest', size: {cols: 150, rows: 30}});
    await sendAll(h.port);
    let s = await h.refresh();
    s = await h.waitFor(/◎ README/);
    capture('digest-150-cursor-first', s);
    const lines = s.split('\n');
    const goal = lines.findIndex(l => l.includes('◎ ログイン画面の二重送信を直す'));
    expect(lines[goal - 1]).toMatch(/fix-login/);
    expect(lines[goal + 1]).toMatch(/送信中はボタンを無効にして/);
    expect(s).toMatch(/◎ 認証ミドルウェアをセッション方式からトークン方式へ移す/);
    expect(s).toMatch(/│ Goal {6}ログイン画面の二重送信を直す/);
    expect(s).toMatch(/│ Progress {2}送信ボタンを押下中は無効にし/);
    expect(s).toMatch(/│ Next {6}レビューの指摘を待つ/);
    expect(s).toMatch(/│ Links\n.*│ {3}PR #58\n.*│ {3}acme\/app#412/);
    expect(s).toMatch(/o links/);
    // カーソルを動かすと、右の欄がその行に替わる
    await h.select('refactor the auth middleware');
    s = await h.waitFor(/│ refactor the auth middleware/);
    capture('digest-150-cursor-second', s);
    expect(s).toMatch(/│ Goal {6}認証ミドルウェアを/);
    expect(s).toMatch(/│ {5}acme\/infra#77|│ {3}acme\/infra#77/);
    // ダイジェストのない行((tty) の行)
    await h.select('scratch');
    s = await h.waitFor(/│ scratch/);
    capture('digest-150-no-digest', s);
    expect(s).toMatch(/│ No digest yet\./);
  });

  it('81: 端末が狭いと右の欄は出ず、Goal の行だけが出る', async () => {
    h = new Harness();
    const app = h.repo('app');
    const demo = h.repo('demo');
    h.agents(rows(app, demo));
    talk(h);
    await h.start({args: '--digest', size: {cols: 110, rows: 30}});
    await sendAll(h.port);
    await h.refresh();
    const s = await h.waitFor(/◎ README/);
    capture('digest-110', s);
    expect(s).not.toMatch(/│ Goal/);
    expect(s).toMatch(/◎ ログイン画面の二重送信を直す/);
  });

  it('82: --digest なしでは、ダイジェストが届いても今までどおり', async () => {
    h = new Harness();
    const app = h.repo('app');
    const demo = h.repo('demo');
    h.agents(rows(app, demo));
    talk(h);
    await h.start({size: {cols: 150, rows: 30}});
    await sendAll(h.port);
    const s = await h.refresh();
    expect(s).not.toMatch(/◎|│ Goal|o links/);
  });

  it('83: n で起動するセッションに --digest のときだけ mod が付く', async () => {
    h = new Harness();
    const app = h.repo('app');
    await h.start({cwd: app, args: '--digest'});
    await h.keys('n', 'Enter');
    await h.waitFor(/fake claude attached/, 10000);
    const call = h.calls().find(c => c.args[0] === '--bg');
    const i = call?.args.indexOf('--plugin-dir') ?? -1;
    expect(i).toBeGreaterThan(0);
    expect(call?.args[i + 1]).toBe(join(REPO, 'mod'));
    const settings = JSON.parse(call?.args[(call?.args.indexOf('--settings') ?? 0) + 1] ?? '{}');
    expect(settings.env.WHATNEXT_DIGEST_PORT).toBe(String(h.port));
    // mod が「ダイジェストを受けているか」を確かめる口: 一覧のセッションの @wn_digest_port に受け口のポートを置く
    expect(settings.env.WHATNEXT_DIGEST_TMUX).toMatch(/\/tmux$/);
    expect(settings.env.WHATNEXT_DIGEST_SOCKET).toMatch(new RegExp(`/${escapeRe(h.socket)}$`));
    expect(live(settings.env.WHATNEXT_DIGEST_SOCKET)).toBe(String(h.port));
  });

  it('83: --digest なしの n には mod が付かない', async () => {
    h = new Harness();
    const app = h.repo('app');
    await h.start({cwd: app});
    await h.keys('n', 'Enter');
    await h.waitFor(/fake claude attached/, 10000);
    const call = h.calls().find(c => c.args[0] === '--bg');
    expect(call?.args).not.toContain('--plugin-dir');
    // ダイジェストを受けていないので、mod が確かめる口も置かない
    expect(live()).toBe('');
  });

  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    it(`82: 作業台でコマンドが動いている間に一覧が ${signal} で終わり、サーバが残っても、mod が確かめる口は残らない`, async () => {
      h = new Harness();
      h.agents([bg('a', {name: 'alpha'})]);
      await h.start({args: '--digest'});
      await h.keys('w');
      await h.waitForSession('sh-a0000000');
      h.inner('send-keys', '-t', '=sh-a0000000:', 'sleep 1007', 'Enter');
      await h.waitForCommand('=sh-a0000000:', 'sleep');
      expect(live()).toBe(String(h.port));
      process.kill(Number(h.inner('show', '-gv', '@wn_pid').trim()), signal);
      await h.waitFor(/\[exit \d+\]/);
      await sleep(500);
      expect(h.sessions()).toContain('sh-a0000000');
      expect(live()).toBe('');
    });
  }

  it('84: o でカーソルの行のリンクを選んで開く。リンクのない行では、ないことを示す', async () => {
    h = new Harness();
    const app = h.repo('app');
    const demo = h.repo('demo');
    h.agents(rows(app, demo));
    await h.start({args: '--digest', size: {cols: 150, rows: 30}});
    await sendAll(h.port);
    await h.refresh();
    await h.select('fix-login');
    await h.keys('o');
    const s = await h.waitFor(/Links of fix-login:/);
    capture('digest-links-menu', s);
    expect(s).toMatch(/^> PR #58 +│\n {2}acme\/app#412 +│$/m);
    await h.keys('Down', 'Enter');
    await h.waitFor(/Opened acme\/app#412\./);
    expect(h.file('open.log').trim()).toBe('https://github.com/acme/app/issues/412');
    await h.select('demo readme');
    await h.keys('o');
    await h.waitFor(/No links for demo readme\./);
  });

  describe('84: o のメニューを開いている間に更新でリンクが替わっても、Enter は画面で選んでいたリンクを開く', () => {
    const L58: [string, string] = ['PR #58', 'https://github.com/acme/app/pull/58'];
    const L412: [string, string] = ['acme/app#412', 'https://github.com/acme/app/issues/412'];
    const L60: [string, string] = ['PR #60', 'https://github.com/acme/app/pull/60'];
    const links = (ls: [string, string][]) => digest('fixlogin', {goal: 'g', progress: 'n', next: 'x'}, ls);

    // 60 秒ごとの更新を、環境変数で短くする(#348)
    const REFRESH_MS = 5000;

    async function openMenuOn412(): Promise<void> {
      const app = h.repo('app');
      h.agents([bg('fixlogin', {name: 'fix-login', cwd: app}), bg('other', {name: 'other', cwd: app})]);
      await h.start({args: '--digest', size: {cols: 150, rows: 30}, env: {WHATNEXT_REFRESH_MS: String(REFRESH_MS)}});
      await post(h.port, links([L58, L412]));
      await h.refresh();
      await h.select('fix-login');
      // 更新の直後に開く(次の更新は REFRESH_MS 後)
      await h.refresh();
      await h.keys('o', 'Down');
      await h.waitFor(/^> acme\/app#412/m);
    }

    /**
     * 自動の更新を1回、まるごと待つ。先に、途中の更新(直前の r など)が終わるのを待つ(`refreshing...` が消える)。
     * 途中の更新の `claude agents` は、控えたあとに記録されうる(偽の claude は起動してから記録する。h.refresh() は
     * 前の更新の Refreshed. で戻ることもある)ので、数えると自動の更新が反映される前に戻ってしまう。
     * 途中の更新が無くなってから数えて2回目の `claude agents` が呼ばれたら、1回目の更新(控えたあとに始まった)は
     * 終わっている(次の更新は、前の更新が終わってから間隔を置いて始まる)。
     */
    async function autoRefresh(): Promise<void> {
      await h.waitFor(s => !/refreshing\.\.\./.test(s), REFRESH_MS + 8000);
      const agentsCalls = () => h.calls().filter(c => c.args[0] === 'agents').length;
      const before = agentsCalls();
      await h.until(
        'two more claude agents calls',
        () => String(agentsCalls()),
        v => Number(v) >= before + 2,
        REFRESH_MS * 2 + 8000,
      );
    }

    it('新しいダイジェストが届いたとき', async () => {
      h = new Harness();
      await openMenuOn412();
      await post(h.port, links([L60, L58, L412]));
      await autoRefresh();
      expect(h.screen()).toMatch(/^> acme\/app#412/m);
      await h.keys('Enter');
      await h.waitFor(/Opened acme\/app#412\./);
      expect(h.file('open.log').trim()).toBe(L412[1]);
    }, 60000);

    it('セッションが消えたとき', async () => {
      h = new Harness();
      await openMenuOn412();
      h.remove(sid('fixlogin').slice(0, 8));
      await autoRefresh();
      await h.keys('Enter');
      await h.waitFor(/Opened acme\/app#412\./);
      expect(h.file('open.log').trim()).toBe(L412[1]);
    }, 60000);
  });

  it('85: 消えたセッションのダイジェストは捨てる。制御文字は落とす', async () => {
    h = new Harness();
    const app = h.repo('app');
    const demo = h.repo('demo');
    h.agents(rows(app, demo));
    await h.start({args: '--digest', size: {cols: 150, rows: 30}});
    await post(h.port, digest('fixlogin', {goal: 'evil\x1b[2Jgoal\nx', progress: 'n', next: 'x'}));
    let s = await h.refresh();
    expect(s).toMatch(/◎ evil\[2Jgoal x/);
    h.remove(sid('fixlogin').slice(0, 8));
    await h.refresh();
    h.agents(rows(app, demo));
    s = await h.refresh();
    expect(s).not.toMatch(/◎ evil/);
  });

  it('81: 右の欄のリンクは、埋め込みのリンク(OSC 8)で端末に届く', async () => {
    // 外側の tmux が端末の代わり。中の tmux は、外側が tmux だと問い合わせの応答で知り、hyperlinks を付ける
    h = new Harness();
    const app = h.repo('app');
    const demo = h.repo('demo');
    h.agents(rows(app, demo));
    await h.start({args: '--digest', size: {cols: 150, rows: 30}, env: {TERM: 'xterm-256color'}});
    await sendAll(h.port);
    await h.refresh();
    await h.select('fix-login');
    await h.waitFor(/│ {3}PR #58/);
    const s = h.screenWithEscapes();
    capture('digest-links-osc8', s);
    // tmux は外側の端末に送るとき、リンクに id を足す(`8;id=tmux1;<URL>`)
    const osc8 = (href: string) => new RegExp(`\x1b\\]8;[^;\x1b]*;${escapeRe(href)}\x1b\\\\(.*?)\x1b\\]8;;\x1b\\\\`);
    expect(s).toMatch(osc8('https://github.com/acme/app/pull/58'));
    expect(osc8('https://github.com/acme/app/pull/58').exec(s)?.[1]).toBe('PR #58');
    expect(osc8('https://github.com/acme/app/issues/412').exec(s)?.[1]).toBe('acme/app#412');
    // 見た目は今までと同じ(リンクの列は幅を取らない)
    expect(h.screen()).toMatch(/│ Links\n.*│ {3}PR #58\n.*│ {3}acme\/app#412/);
  });

  describe('41 の例外: 受け口のポートをほかのプログラムが使っているとき', () => {
    // ポートをふさぐ役。受け口でない HTTP のサーバとして、どの問い合わせにも 404 を返す
    let occupant: Server | undefined;
    afterEach(() => {
      occupant?.close();
      occupant = undefined;
    });

    it('--digest では mod を付けず、右の欄に、ダイジェストが届かない理由を出す', async () => {
      h = new Harness();
      const srv = createServer((_req, res) => {
        res.writeHead(404);
        res.end('not found');
      });
      occupant = srv;
      // 空いたポートを OS に選ばせ、listen が済んでから(ふさいでから)一覧を起動する
      await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
      h.port = (srv.address() as AddressInfo).port;
      const app = h.repo('app');
      h.agents([bg('alpha', {name: 'alpha', cwd: app})]);
      await h.start({cwd: app, args: '--digest', size: {cols: 150, rows: 30}});
      await h.keys('n', 'Enter');
      await h.waitFor(/fake claude attached/, 10000);
      const call = h.calls().find(c => c.args[0] === '--bg');
      expect(h.log()).toMatch(/occupant=other receiver=none digest=true/);
      expect(call?.args).not.toContain('--plugin-dir');
      expect(live()).toBe('');
      await h.keys('C-q', 'C-l');
      await h.select('alpha');
      const s = await h.waitFor(/│ alpha/);
      capture('digest-port-used', s);
      expect(s).not.toMatch(/Digests come from sessions/);
      expect(s).toMatch(new RegExp(`│ Digests are off: port ${h.port} is used by another\\s*\\n.*│ program\\.`));
      // ◎ の行と右の欄はそのまま(o links もキーの説明に残る)
      expect(s).toMatch(/o links/);
    });
  });

  it('86: --digest なしで動いている一覧に whatnext --digest でつなぐと、そのことが示される', async () => {
    h = new Harness();
    h.agents([bg('a', {name: 'alpha'})]);
    await h.start();
    h.open('second', `${h.envLine()} node ${CLI} --digest`);
    const s = await h.waitFor(
      /whatnext is running without --digest\. Quit it, then run "whatnext --digest" to see digests\./,
      10000,
      'second',
    );
    expect(s).toMatch(/alpha/);
  });
});

const WIDE_NAME = 'refactor the auth middleware';
const WIDE = {cols: 120, rows: 30};

describe('81: 右の欄を出していても、一覧の下の確認の問い・入力欄・知らせとメモの入力欄は、端末の幅に収まる限り末尾まで見える', () => {
  it('作業台で2つ動いている行の削除の確認が、[y/N] まで見える', async () => {
    h = new Harness();
    const app = h.repo('app');
    h.agents([
      bg('a', {name: WIDE_NAME, cwd: app, state: 'stopped', pid: undefined, status: undefined}),
      bg('b', {name: 'fix-login', cwd: app}),
    ]);
    await h.start({args: '--digest', size: WIDE});
    await h.select(WIDE_NAME);
    await h.keys('w');
    await h.waitForSession('sh-a0000000');
    h.inner('split-window', '-t', '=sh-a0000000:');
    const panes = h.inner('list-panes', '-t', '=sh-a0000000:', '-F', '#{pane_id}').trim().split('\n');
    h.inner('send-keys', '-t', panes[0] as string, 'tail -f /dev/null', 'Enter');
    h.inner('send-keys', '-t', panes[1] as string, 'sleep 1004', 'Enter');
    await h.waitForCommand(panes[0] as string, 'tail');
    await h.waitForCommand(panes[1] as string, 'sleep');
    await h.keys('C-x');
    await h.waitFor(/Press Ctrl\+X again within 2s to delete\./);
    await h.keys('C-x');
    const s = await h.waitFor(/Delete refactor the auth middleware and stop/);
    capture('digest-wide-confirm', s);
    expect(s).toMatch(/Delete refactor the auth middleware and stop .*\[y\/N\]/);
    await h.keys('n');
  });

  it('知らせが末尾まで見える', async () => {
    h = new Harness();
    const app = h.repo('app');
    h.agents([tty('t', {name: WIDE_NAME, cwd: app}), bg('b', {name: 'fix-login', cwd: app})]);
    await h.start({args: '--digest', size: WIDE});
    await h.select(WIDE_NAME);
    await h.keys('t');
    const s = await h.waitFor(/is an interactive session/);
    capture('digest-wide-notice', s);
    expect(s).toContain(`${WIDE_NAME} is an interactive session. It has no workbench.`);
  });

  it('n の Other... の入力欄が、打った文字の末尾(カーソル)まで見える', async () => {
    h = new Harness();
    const app = h.repo('app');
    h.agents([bg('b', {name: 'fix-login', cwd: app})]);
    await h.start({args: '--digest', size: WIDE, cwd: app});
    await h.keys('n');
    await h.waitFor(/New session in:/);
    await h.type('zzzz');
    await h.keys('Enter');
    await h.waitFor(/Directory:/);
    const path = '~/ghq/github.com/example-org/some-long-repository-name/packages/backend-api';
    await h.type(path);
    const s = await h.waitFor(/Directory: /);
    capture('digest-wide-input', s);
    expect(s).toContain(`Directory: zzzz${path}█`);
  });

  it('メモの入力欄が、打った文字の末尾(カーソル)まで見える', async () => {
    h = new Harness();
    const app = h.repo('app');
    h.agents([bg('a', {name: WIDE_NAME, cwd: app}), bg('b', {name: 'fix-login', cwd: app})]);
    await h.start({args: '--digest', size: WIDE});
    await h.select(WIDE_NAME);
    await h.keys('e');
    await h.waitFor(/Note for /);
    const note = 'wait for the review of PR #58 before merging';
    await h.type(note);
    const s = await h.waitFor(/Note for /);
    capture('digest-wide-note', s);
    expect(s).toContain(`Note for ${WIDE_NAME}: ${note}█`);
  });
});
