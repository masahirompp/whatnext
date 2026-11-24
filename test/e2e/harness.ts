import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join, resolve} from 'node:path';
import {makeTmpDir, tmpTag} from './tmpdir.js';
import {until} from './until.js';

// 画面の通しの口。外側の tmux のセッションを端末の代わりにし、偽の claude を PATH の前に置いて whatnext を動かす
// (driving-whatnext-in-tmux スキル)。テストごとに一時ディレクトリ、ソケット、ポートを分ける。

export const REPO = resolve(import.meta.dirname, '..', '..');
export const CLI = join(REPO, 'dist', 'src', 'cli.js');
const FAKE = join(REPO, 'test', 'e2e', 'fake');
/** 一覧と、その `n` で起動したセッションが引き継ぐダイジェストの変数(`Harness.envLine`)。 */
export const UNSET_DIGEST = [
  'WHATNEXT_DIGEST',
  'WHATNEXT_DIGEST_PORT',
  'WHATNEXT_DIGEST_TMUX',
  'WHATNEXT_DIGEST_SOCKET',
]
  .map(k => `-u ${k}`)
  .join(' ');

export interface FakeRow {
  kind: 'background' | 'interactive';
  sessionId: string;
  id?: string;
  cwd: string;
  name?: string;
  startedAt?: number;
  pid?: number;
  state?: string;
  status?: string;
  waitingFor?: string;
  _fake?: Record<string, unknown>;
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 受け口のポートは 14500〜15899 を PORT_SLOTS 個の区画に分け、ワーカー(VITEST_POOL_ID、1 始まり)ごとに自分の
// 区画から選ぶ。空きを確かめてから一覧が bind するまでに隙があり、ファイルを並行に流すと、別のワーカーが同じ番号を
// 選びうるため。ワーカーの番号がないときは 1 とし、PORT_SLOTS を超えたら区画を共有する(範囲の外には出ない)。
const PORT_BASE = 14500;
const PORT_SLOTS = 8;
const PORT_SLOT_SIZE = 1400 / PORT_SLOTS;

async function freePort(): Promise<number> {
  const worker = Math.max(1, Math.floor(Number(process.env.VITEST_POOL_ID) || 1));
  const from = PORT_BASE + ((worker - 1) % PORT_SLOTS) * PORT_SLOT_SIZE;
  for (let i = 0; i < 50; i++) {
    const port = from + Math.floor(Math.random() * PORT_SLOT_SIZE);
    const ok = await new Promise<boolean>(res => {
      const s = createServer();
      s.once('error', () => res(false));
      s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (ok) return port;
  }
  throw new Error('no free port');
}

export function sid(prefix: string): string {
  const p = prefix.padEnd(8, '0').slice(0, 8);
  return `${p}-1111-2222-3333-444444444444`;
}

/** 背景のセッションの行。 */
export function bg(id: string, over: Partial<FakeRow> = {}): FakeRow {
  return {
    kind: 'background',
    sessionId: sid(id),
    id: sid(id).slice(0, 8),
    cwd: '/tmp',
    name: id,
    startedAt: 1,
    pid: 91000 + Math.floor(Math.random() * 1000),
    state: 'done',
    status: 'idle',
    ...over,
  };
}

/** 対話セッションの行。 */
export function tty(id: string, over: Partial<FakeRow> = {}): FakeRow {
  return {
    kind: 'interactive',
    sessionId: sid(id),
    cwd: '/tmp',
    name: id,
    startedAt: 1,
    pid: 92000 + Math.floor(Math.random() * 1000),
    status: 'waiting',
    waitingFor: 'input needed',
    ...over,
  };
}

/** tmux のソケット名の頭。外側(端末の代わり)と内側(whatnext の専用サーバ)。 */
const OUTER_PREFIX = 'wno-';
const INNER_PREFIX = 'wnx-';

/** ソケット名 `socket` で tmux のサーバが応答するか。サーバは起動しない(`list-sessions` はサーバが無ければ失敗する)。 */
function serverAlive(socket: string): boolean {
  try {
    execFileSync('tmux', ['-L', socket, 'list-sessions'], {stdio: 'ignore', env: {...process.env, TMUX: ''}});
    return true;
  } catch {
    return false;
  }
}

export class Harness {
  readonly dir: string;
  readonly outer: string;
  readonly socket: string;
  port = 0;
  private started = false;

  constructor() {
    // mkdtemp は使わない。乱数の英字に絞り込みの入力(`zq`、`gr` など)が並ぶと、候補がフルパスで当たって残る(#382)
    // 絞り込みの入力に数字を使うと、今度は名前の数字に当たる。テストでは数字を打たない(DESIGN.md「確かめ方」)
    // 名前の空間は 10^6 で、一時ディレクトリが消えて tmux のサーバだけが生きている名前(WN_KEEP=1 で残したあと、
    // ディレクトリだけを消したときなど)を引きうる。引くと古いサーバにつながるので、その名前から作るソケットの
    // どちらかでサーバが応答したら、名前を作り直す。応答したサーバは止めない(並行に流れている通しのものかもしれない)
    this.dir = realpathSync(
      makeTmpDir('/tmp/wne-', Math.random, d => [OUTER_PREFIX, INNER_PREFIX].some(p => serverAlive(p + tmpTag(d)))),
    );
    const tag = tmpTag(this.dir);
    this.outer = OUTER_PREFIX + tag;
    this.socket = INNER_PREFIX + tag;
    for (const d of ['state', 'cfg/projects', 'home', 'bin']) mkdirSync(join(this.dir, d), {recursive: true});
    writeFileSync(join(this.dir, 'agents.json'), '[]');
    writeFileSync(join(this.dir, 'fake.json'), '{}');
  }

  /** テスト用のディレクトリ(git でない)を作って返す。 */
  mkdir(name: string): string {
    const p = join(this.dir, 'w', name);
    mkdirSync(p, {recursive: true});
    return p;
  }

  /** git のリポジトリを作って返す。 */
  repo(name: string): string {
    const p = this.mkdir(name);
    const g = (...a: string[]) =>
      execFileSync('git', a, {
        cwd: p,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@x',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@x',
        },
      });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(p, 'README'), 'x');
    g('add', '.');
    g('commit', '-qm', 'i');
    return p;
  }

  agents(rows: FakeRow[]): void {
    writeFileSync(join(this.dir, 'agents.json'), JSON.stringify(rows, null, 2));
  }

  readAgents(): FakeRow[] {
    return JSON.parse(readFileSync(join(this.dir, 'agents.json'), 'utf8'));
  }

  /** 行の一部を書き換える。 */
  update(id: string, over: Partial<FakeRow>): void {
    const rows = this.readAgents().map(r =>
      r.id === id || r.sessionId.startsWith(id) || r.name === id ? {...r, ...over} : r,
    );
    this.agents(rows);
  }

  remove(id: string): void {
    this.agents(this.readAgents().filter(r => !(r.id === id || r.name === id)));
  }

  /** 偽の ps が返すプロセス表(pid と親の pid)。 */
  procs(pairs: [number, number][]): void {
    writeFileSync(join(this.dir, 'ps.txt'), `${pairs.map(([p, pp]) => `${p} ${pp}`).join('\n')}\n`);
  }

  /** 偽の ps -E が返す、pid ごとのコマンド行と環境変数。 */
  procEnv(lines: string[]): void {
    writeFileSync(join(this.dir, 'ps-env.txt'), `${lines.join('\n')}\n`);
  }

  conf(c: Record<string, unknown>): void {
    writeFileSync(join(this.dir, 'fake.json'), JSON.stringify(c));
  }

  /** 会話記録を置く。 */
  transcript(sessionId: string, lines: object[]): void {
    const d = join(this.dir, 'cfg', 'projects', 'p');
    mkdirSync(d, {recursive: true});
    writeFileSync(join(d, `${sessionId}.jsonl`), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`);
  }

  statePath(): string {
    return join(this.dir, 'state', 'whatnext', `state-${this.socket}.json`);
  }

  writeState(s: object): void {
    mkdirSync(join(this.dir, 'state', 'whatnext'), {recursive: true});
    writeFileSync(this.statePath(), JSON.stringify(s));
  }

  state(): {
    notes: Record<string, string>;
    waits: Record<string, string[]>;
    seen: Record<string, {first: number; attached?: number}>;
  } {
    return JSON.parse(readFileSync(this.statePath(), 'utf8'));
  }

  /**
   * whatnext を起動するコマンドの環境。`WHATNEXT_DIGEST*` は外す。0.24 までは、`whatnext --digest` の `n` で起動した
   * セッション(そこで動く AI)から流すと、シェルに `WHATNEXT_DIGEST=1` が入っていて、`--digest` なしのはずの一覧が
   * `--digest` で動いた(18件が落ちた)。今の起動の口は引数だけで決め、一覧の役には値をいつも明示して渡すので、
   * 引き継いだ値は効かない。外すのは、テストの環境を引き継いだ値に頼らせないため。
   */
  envLine(extra: Record<string, string> = {}): string {
    const vars: Record<string, string> = {
      WHATNEXT_ROLE: '',
      WHATNEXT_TMUX_SOCKET: this.socket,
      WHATNEXT_PORT: String(this.port),
      XDG_STATE_HOME: join(this.dir, 'state'),
      CLAUDE_CONFIG_DIR: join(this.dir, 'cfg'),
      FAKE_DIR: this.dir,
      WHATNEXT_DEBUG_LOG: join(this.dir, 'debug.log'),
      ...extra,
    };
    const assigns = Object.entries(vars).map(([k, v]) => `${k}=${q(v)}`);
    return `env -u TMUX -u TMUX_PANE -u CLAUDECODE ${UNSET_DIGEST} ${assigns.join(' ')} PATH=${q(join(this.dir, 'bin'))}:${q(FAKE)}:"$PATH"`;
  }

  private tmux(...args: string[]): string {
    return execFileSync('tmux', ['-L', this.outer, ...args], {encoding: 'utf8', env: {...process.env, TMUX: ''}});
  }

  /**
   * 内側の tmux でコマンドを動かし、標準出力を返す。失敗したら '' を返し、tmux の標準エラーはそのまま出す。
   * 1回だけ動かす操作や確かめに使い、失敗の理由がテストの出力に残るようにする。
   */
  inner(...args: string[]): string {
    try {
      return execFileSync('tmux', ['-L', this.socket, ...args], {encoding: 'utf8', env: {...process.env, TMUX: ''}});
    } catch {
      return '';
    }
  }

  /** `inner` と同じだが、tmux の標準エラーを出さない。`until` の probe など、待つ間に何度も問い合わせるときに使う。 */
  innerQuiet(...args: string[]): string {
    try {
      return execFileSync('tmux', ['-L', this.socket, ...args], {
        encoding: 'utf8',
        env: {...process.env, TMUX: ''},
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  }

  /** 外側の tmux のセッション `name` でコマンドを動かす(端末の代わり)。 */
  open(name: string, cmd: string, size = {cols: 120, rows: 32}, cwd = join(this.dir, 'home')): void {
    const full = `cd ${q(cwd)} && ${cmd}; echo "[exit $?]"; sleep 600`;
    if (!this.started) {
      this.tmux(
        '-f',
        '/dev/null',
        'new-session',
        '-d',
        '-s',
        name,
        '-x',
        String(size.cols),
        '-y',
        String(size.rows),
        full,
      );
      this.tmux('set', '-g', 'status', 'off');
      this.tmux('set', '-s', 'escape-time', '10');
      this.started = true;
    } else {
      try {
        this.tmux('kill-session', '-t', `=${name}`);
      } catch {}
      this.tmux('new-session', '-d', '-s', name, '-x', String(size.cols), '-y', String(size.rows), full);
    }
  }

  /**
   * 一覧を開く。`args` を渡さなければ `--no-digest` で開く(ダイジェストに関係しないテストの画面に、右の欄や Goal の行を
   * 出さないため)。既定(ダイジェストが有効)で開くテストは `args: ''` を渡す。
   */
  async start(
    opts: {
      size?: {cols: number; rows: number};
      args?: string;
      env?: Record<string, string>;
      cwd?: string;
      wait?: boolean;
    } = {},
  ): Promise<void> {
    if (!this.port) this.port = await freePort();
    this.open('main', `${this.envLine(opts.env)} node ${q(CLI)} ${opts.args ?? '--no-digest'}`, opts.size, opts.cwd);
    if (opts.wait !== false) await this.waitFor(s => /SESSION|No sessions|Could not read/.test(s), 15000);
  }

  /**
   * whatnext の画面(外側の tmux のセッション `main`)を閉じ、その画面のクライアントが内側の tmux から離れるまで待つ。
   * 端末のウィンドウを閉じたときと同じで、一覧のプロセスは終わらない(DESIGN.md)ので、`@wn_pid` では待てない。
   * 閉じる前にクライアントの tty を控え、`list-clients` からその tty が消えるのを待つ(#349)。
   */
  async closeMain(timeout = 8000): Promise<void> {
    const tty = this.tmux('display', '-p', '-t', '=main:', '#{pane_tty}').trim();
    const ttys = () => this.innerQuiet('list-clients', '-F', '#{client_tty}').trim();
    if (!ttys().split('\n').includes(tty)) {
      throw new Error(`the whatnext screen (${tty}) is not a client of the inner tmux`);
    }
    this.tmux('kill-session', '-t', '=main');
    await this.until(
      `the whatnext screen client (${tty}) to leave the inner tmux`,
      ttys,
      v => !v.split('\n').includes(tty),
      timeout,
    );
  }

  /**
   * 外側の tmux のセッション `name` で `whatnext workbench` を動かし、その画面が内側の tmux のクライアントになるまで待つ。
   * 戻った時点では、作業台の画面(案内の文、ステータス行の名前など)はまだ描かれていないことがある。確かめるものは、
   * 呼び出し側が waitFor で待つ(案内の文とステータス行は別々に描かれるので、片方が出ても、もう片方はまだのことがある)。
   */
  async startWorkbench(name = 'wb', size = {cols: 80, rows: 20}): Promise<void> {
    this.open(name, `${this.envLine()} node ${q(CLI)} workbench`, size);
    const tty = this.tmux('display', '-p', '-t', `=${name}:`, '#{pane_tty}').trim();
    await this.until(
      `the workbench screen client (${tty}) to join the inner tmux`,
      () => this.innerQuiet('list-clients', '-F', '#{client_tty}').trim(),
      v => v.split('\n').includes(tty),
    );
  }

  /** 1キーずつ送る(人の操作を再現する)。 */
  async keys(...ks: string[]): Promise<void> {
    await this.keysTo('main', ...ks);
  }

  async keysTo(session: string, ...ks: string[]): Promise<void> {
    for (const k of ks) {
      this.tmux('send-keys', '-t', `=${session}:`, k);
      // Esc は外側の tmux を挟むと約 500ms 遅れて届き、その前に次のキーが来るとまとめて届く(#278)
      await sleep(k === 'Escape' ? 700 : 150);
    }
  }

  async type(text: string, session = 'main'): Promise<void> {
    this.tmux('send-keys', '-t', `=${session}:`, '-l', text);
    await sleep(150);
  }

  screen(session = 'main'): string {
    return this.tmux('capture-pane', '-p', '-t', `=${session}:`);
  }

  /** 色や埋め込みのリンク(OSC 8)の列を含めて取る(端末に届いたもの)。 */
  screenWithEscapes(session = 'main'): string {
    return this.tmux('capture-pane', '-e', '-p', '-t', `=${session}:`);
  }

  lines(session = 'main'): string[] {
    return this.screen(session).replace(/\n$/, '').split('\n');
  }

  async waitFor(pred: RegExp | ((s: string) => boolean), timeout = 8000, session = 'main'): Promise<string> {
    const test = typeof pred === 'function' ? pred : (s: string) => pred.test(s);
    const end = Date.now() + timeout;
    let s = '';
    while (Date.now() < end) {
      try {
        s = this.screen(session);
      } catch {
        s = '';
      }
      if (test(s)) return s;
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${String(pred)}; screen was:\n${s}`);
  }

  /**
   * `probe` の値が `ok` を満たすまで待つ(`./until.ts`。probe の例外は待ち続け、期限のあとにもう一度だけ確かめる)。
   * 作業台やペインに送ったあとは、固定の時間ではなく、これで観測できる状態を待つ(負荷が高いと遅れるため。#346)。
   * 内側の tmux に問い合わせる probe は `innerQuiet` を使う。
   */
  until(what: string, probe: () => string, ok: (v: string) => boolean, timeout = 8000): Promise<string> {
    return until(what, probe, ok, timeout);
  }

  /**
   * 内側の tmux にセッション `name` ができるまで待つ。作業台は一覧が非同期に作るので、キーを押しただけではまだない。
   * 戻った時点では、セッションのオプション(prefix、status、`@wn_name` など)はまだ入っていないことがある。
   */
  async waitForSession(name: string, timeout = 8000): Promise<void> {
    await this.until(
      `inner tmux session ${name}`,
      () => this.innerQuiet('list-sessions', '-F', '#{session_name}').trim().split('\n').join(' '),
      v => v.split(' ').includes(name),
      timeout,
    );
  }

  /**
   * 内側の tmux のペイン `target` の前面のコマンド(`#{pane_current_command}`)が `command` になるまで待つ。
   * send-keys で送っても、シェルが起動して読むまではコマンドは動いていない。
   */
  async waitForCommand(target: string, command: string | RegExp, timeout = 8000): Promise<void> {
    const ok = typeof command === 'string' ? (v: string) => v === command : (v: string) => command.test(v);
    await this.until(
      `pane ${target} to run ${String(command)}`,
      () => this.innerQuiet('display', '-p', '-t', target, '#{pane_current_command}').trim(),
      ok,
      timeout,
    );
  }

  /**
   * 一覧で、名前の行にカーソルを合わせる。画面からカーソルの行(`> `)と、名前で始まる行の位置を読んで向きを決め、
   * 1キーごとに画面で確かめる(見出しや起動された行は飛ばされるので、押す回数は決めない)。目当ての行が見えない、
   * 上下の両方にある、押しても画面が変わらない、向きが逆になる、のどれかのときは、上へ走査してから下へ走査する。
   */
  async select(name: string): Promise<void> {
    const re = new RegExp(`^> .*?${escapeRe(name)}`, 'm');
    const row = new RegExp(`^ {2}[ │├└]*${escapeRe(name)}`);
    let prev: string | undefined;
    let dir: 'Up' | 'Down' | undefined;
    for (let i = 0; i < 60; i++) {
      const s = this.screen();
      if (re.test(s)) return;
      if (s === prev) break;
      const lines = s.split('\n');
      const cur = lines.findIndex(l => l.startsWith('> '));
      const at = lines.flatMap((l, j) => (row.test(l) ? [j] : []));
      if (cur < 0 || at.length === 0) break;
      const next = at.every(j => j < cur) ? 'Up' : at.every(j => j > cur) ? 'Down' : undefined;
      if (!next || (dir && next !== dir)) break;
      dir = next;
      prev = s;
      await this.keys(next);
    }
    for (let i = 0; i < 30; i++) {
      if (re.test(this.screen())) return;
      await this.keys('Up');
    }
    for (let i = 0; i < 60; i++) {
      if (re.test(this.screen())) return;
      await this.keys('Down');
    }
    throw new Error(`could not select ${name}:\n${this.screen()}`);
  }

  /**
   * 消したセッション `name` が画面から消えるまで待ち、`Deleted <name>.` の知らせが出たことを確かめる。
   * 知らせの文言だけは名前が残っていてよいとする。知らせは 5 秒出るので、画面全体から名前が消えるのを待つと、
   * 行が消えたあとも知らせが消えるまで待ってしまう。
   * 一覧は rm が通ってから作業台を畳み、そのあとで知らせを出すので、その間に別の更新で行が消えた画面が先に描かれる
   * ことがある。行が消えていても、知らせが出るまでは待ち続ける。
   */
  async waitDeleted(name: string, timeout = 8000): Promise<string> {
    const notice = `Deleted ${name}.`;
    let noticed = false;
    try {
      return await this.waitFor(v => {
        if (v.includes(notice)) noticed = true;
        return noticed && !v.replaceAll(notice, '').includes(name);
      }, timeout);
    } catch (e) {
      if (noticed) throw e;
      throw new Error(`"${notice}" was not shown; ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 更新を押して終わるまで待つ。 */
  async refresh(): Promise<string> {
    await this.keys('r');
    return this.waitFor(s => /Refreshed\./.test(s));
  }

  calls(): {args: string[]; cwd: string}[] {
    const p = join(this.dir, 'calls.log');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  }

  file(name: string): string {
    const p = join(this.dir, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }

  clients(): {tty: string; session: string}[] {
    return this.inner('list-clients', '-F', '#{client_tty} #{session_name}')
      .split('\n')
      .filter(Boolean)
      .map(l => {
        const [t, s] = l.split(' ');
        return {tty: t, session: s};
      });
  }

  sessions(): string[] {
    return this.inner('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean);
  }

  log(): string {
    return this.file('debug.log');
  }

  cleanup(): void {
    if (process.env.WN_KEEP) return;
    try {
      rmSync(join(REPO, 'test', 'e2e', '.tmp', this.socket), {recursive: true, force: true});
    } catch {}
    try {
      execFileSync('tmux', ['-L', this.socket, 'kill-server'], {stdio: 'ignore'});
    } catch {}
    try {
      execFileSync('tmux', ['-L', this.outer, 'kill-server'], {stdio: 'ignore'});
    } catch {}
    try {
      rmSync(this.dir, {recursive: true, force: true});
    } catch {}
  }
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
