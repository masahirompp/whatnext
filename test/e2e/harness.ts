import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

// 画面の通しの口。外側の tmux のセッションを端末の代わりにし、偽の claude を PATH の前に置いて whatnext を動かす
// (driving-whatnext-in-tmux スキル)。テストごとに一時ディレクトリ、ソケット、ポートを分ける。

export const REPO = resolve(import.meta.dirname, '..', '..');
const CLI = join(REPO, 'dist', 'src', 'cli.js');
const FAKE = join(REPO, 'test', 'e2e', 'fake');

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

async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 14500 + Math.floor(Math.random() * 1400);
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

export class Harness {
  readonly dir: string;
  readonly outer: string;
  readonly socket: string;
  port = 0;
  private started = false;

  constructor() {
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), 'wne-')));
    const tag = this.dir.slice(-6).replace(/[^a-zA-Z0-9]/g, 'x');
    this.outer = `wno-${tag}`;
    this.socket = `wnx-${tag}`;
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
    return `env -u TMUX -u TMUX_PANE ${assigns.join(' ')} PATH=${q(join(this.dir, 'bin'))}:${q(FAKE)}:"$PATH"`;
  }

  private tmux(...args: string[]): string {
    return execFileSync('tmux', ['-L', this.outer, ...args], {encoding: 'utf8', env: {...process.env, TMUX: ''}});
  }

  inner(...args: string[]): string {
    try {
      return execFileSync('tmux', ['-L', this.socket, ...args], {encoding: 'utf8', env: {...process.env, TMUX: ''}});
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
      this.started = true;
    } else {
      try {
        this.tmux('kill-session', '-t', `=${name}`);
      } catch {}
      this.tmux('new-session', '-d', '-s', name, '-x', String(size.cols), '-y', String(size.rows), full);
    }
  }

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
    this.open('main', `${this.envLine(opts.env)} node ${q(CLI)} ${opts.args ?? ''}`, opts.size, opts.cwd);
    if (opts.wait !== false) await this.waitFor(s => /SESSION|No sessions|Could not read/.test(s), 15000);
  }

  async startWorkbench(name = 'wb', size = {cols: 80, rows: 20}): Promise<void> {
    this.open(name, `${this.envLine()} node ${q(CLI)} workbench`, size);
    await sleep(800);
  }

  /** 1キーずつ送る(人の操作を再現する)。 */
  async keys(...ks: string[]): Promise<void> {
    await this.keysTo('main', ...ks);
  }

  async keysTo(session: string, ...ks: string[]): Promise<void> {
    for (const k of ks) {
      this.tmux('send-keys', '-t', `=${session}:`, k);
      await sleep(150);
    }
  }

  async type(text: string, session = 'main'): Promise<void> {
    this.tmux('send-keys', '-t', `=${session}:`, '-l', text);
    await sleep(150);
  }

  screen(session = 'main'): string {
    return this.tmux('capture-pane', '-p', '-t', `=${session}:`);
  }

  lines(session = 'main'): string[] {
    return this.screen(session).split('\n');
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

  /** 一覧で、名前の行にカーソルを合わせる。 */
  async select(name: string): Promise<void> {
    const re = new RegExp(`^> .*?${escapeRe(name)}`, 'm');
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
