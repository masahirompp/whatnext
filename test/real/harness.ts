// 実機の通しの仕掛け: 実物の claude(haiku)で whatnext を動かす。
// テスト用の一時ディレクトリ(信頼の確認を済ませたもの)、専用のソケット、ポート、状態のファイルを使い、
// 利用者の whatnext とそのセッションには触れない。起動したセッションは、終わったら claude stop と claude rm で消す。

import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** テスト用の作業ディレクトリ(git でない)。信頼の確認は初回だけ行う。 */
export const WORKDIR = '/tmp/whatnext-real';

interface JsonRow {
  kind: string;
  sessionId: string;
  id?: string;
  cwd: string;
  name?: string;
  state?: string;
  status?: string;
  waitingFor?: string;
  pid?: number;
}

export function agents(): JsonRow[] {
  const out = execFileSync('claude', ['agents', '--json', '--all'], {encoding: 'utf8'});
  return JSON.parse(out) as JsonRow[];
}

function under(cwd: string, dir: string): boolean {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {}
  return [dir, real].some(d => cwd === d || cwd.startsWith(`${d}/`));
}

/** テスト用のディレクトリで動いているセッション(利用者のセッションは含まない)。 */
export function testSessions(dir = WORKDIR): JsonRow[] {
  return agents().filter(r => r.kind === 'background' && r.id && under(r.cwd, dir));
}

export function cleanupSessions(dir = WORKDIR): void {
  for (const r of testSessions(dir)) {
    spawnSync('claude', ['stop', r.id as string], {encoding: 'utf8'});
  }
  const deadline = Date.now() + 30000;
  for (const r of testSessions(dir)) {
    for (;;) {
      const res = spawnSync('claude', ['rm', r.id as string], {encoding: 'utf8'});
      if (res.status === 0 || Date.now() > deadline) break;
      execFileSync('sleep', ['1']);
    }
  }
}

function trusted(dir: string): boolean {
  try {
    const data = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as {
      projects?: Record<string, {hasTrustDialogAccepted?: boolean}>;
    };
    return [dir, realpathSync(dir)].some(d => data.projects?.[d]?.hasTrustDialogAccepted === true);
  } catch {
    return false;
  }
}

let counter = 0;

export class RealHarness {
  readonly tag = `${process.pid.toString(36)}${(counter++).toString(36)}`;
  readonly root = `/tmp/wnr-${this.tag}`;
  readonly socket = `wnr-${this.tag}`;
  readonly outer = `wnro-${this.tag}`;
  readonly port = 16000 + ((process.pid * 7 + counter * 13) % 3000);
  readonly state = join(this.root, 'state');

  constructor() {
    rmSync(this.root, {recursive: true, force: true});
    mkdirSync(this.state, {recursive: true});
    mkdirSync(WORKDIR, {recursive: true});
  }

  /** 作業ディレクトリの信頼の確認を、対話モードの claude で済ませる(初回だけ)。 */
  async ensureTrusted(): Promise<void> {
    if (trusted(WORKDIR)) return;
    const s = `trust-${this.tag}`;
    spawnSync(
      'tmux',
      [
        '-L',
        this.outer,
        '-f',
        '/dev/null',
        'new-session',
        '-d',
        '-s',
        s,
        '-x',
        '120',
        '-y',
        '30',
        '-c',
        WORKDIR,
        'claude --model haiku',
      ],
      {
        env: {...process.env, TMUX: ''},
      },
    );
    for (let i = 0; i < 60 && !/trust/i.test(this.screen(s)); i++) await sleep(500);
    spawnSync('tmux', ['-L', this.outer, 'send-keys', '-t', `=${s}:`, 'Down']);
    await sleep(500);
    spawnSync('tmux', ['-L', this.outer, 'send-keys', '-t', `=${s}:`, 'Enter']);
    for (let i = 0; i < 40 && !trusted(WORKDIR); i++) await sleep(500);
    spawnSync('tmux', ['-L', this.outer, 'kill-session', '-t', `=${s}`]);
    rmSync(`/private/tmp/tmux-${process.getuid?.()}/${this.outer}`, {force: true});
    if (!trusted(WORKDIR)) throw new Error(`could not trust ${WORKDIR}`);
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.TMUX;
    delete env.TMUX_PANE;
    return {
      ...env,
      WHATNEXT_ROLE: '',
      WHATNEXT_TMUX_SOCKET: this.socket,
      WHATNEXT_PORT: String(this.port),
      XDG_STATE_HOME: this.state,
      WHATNEXT_DEBUG_LOG: join(this.root, 'debug.log'),
      ...extra,
    };
  }

  open(name: string, args: string[] = [], opts: {cols?: number; rows?: number; cwd?: string} = {}): void {
    const vars = Object.entries(this.env())
      .filter(([k]) => /^(WHATNEXT_|XDG_STATE_HOME$|PATH$|HOME$|LANG$|USER$|SHELL$)/.test(k))
      .map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`)
      .join(' ');
    const cmd = `env ${vars} node ${CLI} ${args.join(' ')}; echo "[exit $?]"; sleep 100000`;
    const r = spawnSync(
      'tmux',
      [
        ...['-L', this.outer, '-f', '/dev/null', 'start-server', ';', 'set', '-g', 'default-shell', '/bin/sh', ';'],
        ...['new-session', '-d', '-s', name, '-x', String(opts.cols ?? 140), '-y', String(opts.rows ?? 35)],
        ...['-c', opts.cwd ?? WORKDIR, cmd],
      ],
      {encoding: 'utf8', env: {...process.env, TMUX: ''}},
    );
    if (r.status !== 0) throw new Error(r.stderr);
  }

  async keys(name: string, ...keys: string[]): Promise<void> {
    for (const k of keys) {
      spawnSync('tmux', ['-L', this.outer, 'send-keys', '-t', `=${name}:`, k]);
      await sleep(200);
    }
  }

  async type(name: string, text: string): Promise<void> {
    spawnSync('tmux', ['-L', this.outer, 'send-keys', '-t', `=${name}:`, '-l', text]);
    await sleep(300);
  }

  screen(name: string): string {
    const r = spawnSync('tmux', ['-L', this.outer, 'capture-pane', '-p', '-t', `=${name}:`], {encoding: 'utf8'});
    return r.stdout ?? '';
  }

  async waitFor(name: string, pattern: RegExp | string, timeout = 60000): Promise<string> {
    const re = typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : pattern;
    const end = Date.now() + timeout;
    let last = '';
    while (Date.now() < end) {
      last = this.screen(name);
      if (re.test(last)) return last;
      await sleep(300);
    }
    throw new Error(`timed out waiting for ${re} on ${name}:\n${last}`);
  }

  /** 更新キーを押しながら、一覧に `pattern` が出るまで待つ。 */
  async refreshUntil(name: string, pattern: RegExp | string, timeout = 90000): Promise<string> {
    const re = typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : pattern;
    const end = Date.now() + timeout;
    let last = '';
    while (Date.now() < end) {
      await this.keys(name, 'r');
      await sleep(2500);
      last = this.screen(name);
      if (re.test(last)) return last;
    }
    throw new Error(`timed out waiting for ${re} on ${name}:\n${last}`);
  }

  selected(name: string): string {
    return (
      this.screen(name)
        .split('\n')
        .find(l => l.startsWith('> '))
        ?.trim() ?? ''
    );
  }

  async select(name: string, session: string): Promise<void> {
    const re = new RegExp(`^> [│├└ ]*${session}`);
    for (let i = 0; i < 20 && !re.test(this.selected(name)); i++) await this.keys(name, 'Up');
    for (let i = 0; i < 40 && !re.test(this.selected(name)); i++) await this.keys(name, 'Down');
    if (!re.test(this.selected(name))) throw new Error(`could not select ${session}:\n${this.screen(name)}`);
  }

  tmux(...args: string[]): string {
    return spawnSync('tmux', ['-L', this.socket, ...args], {encoding: 'utf8'}).stdout ?? '';
  }

  sessions(): string[] {
    return this.tmux('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean);
  }

  debugLog(): string {
    const p = join(this.root, 'debug.log');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }

  cleanup(): void {
    spawnSync('tmux', ['-L', this.socket, 'kill-server']);
    spawnSync('tmux', ['-L', this.outer, 'kill-server']);
    cleanupSessions();
    rmSync(this.root, {recursive: true, force: true});
    for (const s of [this.socket, this.outer]) rmSync(`/private/tmp/tmux-${process.getuid?.()}/${s}`, {force: true});
  }
}

/** 外で(whatnext を通さずに)起動する。id を返す。 */
export function launchOutside(prompt: string, name: string): string {
  const out = execFileSync('claude', ['--bg', '--model', 'haiku', '--name', name, '--', prompt], {
    cwd: WORKDIR,
    encoding: 'utf8',
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 色を除く
  const m = /backgrounded\s*·\s*([^\s·]+)/.exec(out.replace(/\x1b\[[0-9;]*m/g, ''));
  if (!m) throw new Error(`could not launch: ${out}`);
  return m[1] as string;
}

export async function waitState(id: string, pred: (r: JsonRow) => boolean, timeout = 60000): Promise<JsonRow> {
  const end = Date.now() + timeout;
  let last: JsonRow | undefined;
  while (Date.now() < end) {
    last = agents().find(r => r.id === id && r.kind === 'background') ?? agents().find(r => r.id === id);
    if (last && pred(last)) return last;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${id}: ${JSON.stringify(last)}`);
}

export const PERM_PROMPT = (tag: string) =>
  `Use the Bash tool to run exactly: date > /private/tmp/claude-501/wn-real-${tag}.txt . Then report the result.`;
