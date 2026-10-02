// 画面の通しの仕掛け: 外側の tmux を端末の代わりにし、専用のソケット、ポート、状態のファイル、偽の claude で whatnext を動かす。
// 利用者の whatnext(ソケット whatnext、ポート 14318)には触れない。

import {execFileSync, spawnSync} from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const FAKE = join(import.meta.dirname, 'fake');

const which = (cmd: string) => execFileSync('sh', ['-c', `command -v ${cmd}`], {encoding: 'utf8'}).trim();

export interface Row {
  kind?: string;
  sessionId?: string;
  id?: string;
  cwd?: string;
  name?: string;
  pid?: number;
  state?: string;
  status?: string;
  waitingFor?: string;
  startedAt?: number;
  unpushed?: boolean;
  uncommitted?: boolean;
}

let counter = 0;

/** 8 桁の16進の id と、それを先頭に持つ sessionId。 */
export function ids(n: number): {id: string; sessionId: string} {
  const id = (0xa0000000 + n).toString(16);
  return {id, sessionId: `${id}-0000-4000-8000-${String(n).padStart(12, '0')}`};
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Harness {
  readonly tag = `${process.pid.toString(36)}${(counter++).toString(36)}`;
  readonly root = `/tmp/wne-${this.tag}`;
  readonly socket = `wne-${this.tag}`;
  readonly outer = `wnx-${this.tag}`;
  readonly port = 15000 + ((process.pid * 7 + counter * 13) % 4000);
  readonly fake = join(this.root, 'fake');
  readonly bin = join(this.root, 'bin');
  readonly repo = join(this.root, 'repo');
  readonly cfg = join(this.root, 'cfg');
  readonly state = join(this.root, 'state');

  constructor(opts: {ghq?: string[]; gh?: boolean} = {}) {
    rmSync(this.root, {recursive: true, force: true});
    for (const d of [this.fake, this.bin, this.repo, this.cfg, this.state]) mkdirSync(d, {recursive: true});
    for (const f of ['claude', 'open']) {
      copyFileSync(join(FAKE, f), join(this.bin, f));
      chmodSync(join(this.bin, f), 0o755);
    }
    symlinkSync(which('tmux'), join(this.bin, 'tmux'));
    if (opts.ghq) {
      writeFileSync(join(this.bin, 'ghq'), `#!/bin/sh\nprintf '%s\\n' ${opts.ghq.map(p => `'${p}'`).join(' ')}\n`);
      chmodSync(join(this.bin, 'ghq'), 0o755);
    }
    if (opts.gh) {
      writeFileSync(
        join(this.bin, 'gh'),
        `#!/bin/sh\n[ -f "$WN_FAKE_DIR/gh.json" ] && cat "$WN_FAKE_DIR/gh.json" && exit 0\necho '[]'\n`,
      );
      chmodSync(join(this.bin, 'gh'), 0o755);
    }
    execFileSync('git', ['init', '-q', '-b', 'main', this.repo]);
    execFileSync('git', [
      '-C',
      this.repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'i',
    ]);
    this.setAgents([]);
  }

  get path(): string {
    return [this.bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      WHATNEXT_ROLE: '',
      WHATNEXT_TMUX_SOCKET: this.socket,
      WHATNEXT_PORT: String(this.port),
      XDG_STATE_HOME: this.state,
      CLAUDE_CONFIG_DIR: this.cfg,
      WN_FAKE_DIR: this.fake,
      WHATNEXT_DEBUG_LOG: join(this.root, 'debug.log'),
      SHELL: '/bin/sh',
      HOME: process.env.HOME ?? '/tmp',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      PATH: this.path,
      ...extra,
    };
  }

  agents(): Row[] {
    return JSON.parse(readFileSync(join(this.fake, 'agents.json'), 'utf8'));
  }

  setAgents(rows: Row[]): void {
    writeFileSync(join(this.fake, 'agents.json'), JSON.stringify(rows, null, 2));
  }

  /** 行を足す(既定は repo で動く background のレビュー待ち)。 */
  row(n: number, extra: Row = {}): Row {
    return {
      kind: 'background',
      ...ids(n),
      cwd: this.repo,
      name: `s${n}`,
      pid: 1000 + n,
      state: 'done',
      status: 'idle',
      startedAt: Date.now(),
      ...extra,
    };
  }

  update(id: string, patch: Partial<Row> | null): void {
    const rows = this.agents();
    const i = rows.findIndex(r => r.id === id);
    if (i < 0) return;
    if (patch === null) rows.splice(i, 1);
    else {
      rows[i] = {...rows[i], ...patch};
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (rows[i] as Record<string, unknown>)[k];
    }
    this.setAgents(rows);
  }

  behave(name: string, value: string | null): void {
    const p = join(this.fake, `behavior-${name}`);
    if (value === null) rmSync(p, {force: true});
    else writeFileSync(p, value);
  }

  calls(): string[] {
    const p = join(this.fake, 'calls.log');
    return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
  }

  log(name: string): string[] {
    const p = join(this.fake, name);
    return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
  }

  private sh(cmd: string, env: Record<string, string>): string {
    const vars = Object.entries(env)
      .map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`)
      .join(' ');
    return `env ${vars} ${cmd}; echo "[exit $?]"; sleep 100000`;
  }

  /** 外側の tmux のセッション(端末の代わり)を作り、そこで whatnext を動かす。 */
  open(
    name: string,
    args: string[] = [],
    opts: {cols?: number; rows?: number; env?: Record<string, string>; cwd?: string} = {},
  ): void {
    const cmd = this.sh(`node ${CLI} ${args.join(' ')}`, this.env(opts.env));
    const exists = spawnSync('tmux', ['-L', this.outer, 'has-session', '-t', `=${name}`]).status === 0;
    if (exists) spawnSync('tmux', ['-L', this.outer, 'kill-session', '-t', `=${name}`]);
    const base = ['-L', this.outer, '-f', '/dev/null'];
    const r = spawnSync(
      'tmux',
      [
        ...base,
        'start-server',
        ';',
        'set',
        '-g',
        'default-shell',
        '/bin/sh',
        ';',
        'new-session',
        '-d',
        '-s',
        name,
        '-x',
        String(opts.cols ?? 120),
        '-y',
        String(opts.rows ?? 30),
        '-c',
        opts.cwd ?? this.repo,
        cmd,
      ],
      {encoding: 'utf8', env: {...process.env, TMUX: ''}},
    );
    if (r.status !== 0) throw new Error(`outer tmux failed: ${r.stderr}`);
  }

  /** 外側のセッションを閉じる(端末のウィンドウを閉じる)。 */
  closeTerminal(name: string): void {
    spawnSync('tmux', ['-L', this.outer, 'kill-session', '-t', `=${name}`]);
  }

  /** 1キーずつ送る。 */
  async keys(name: string, ...keys: string[]): Promise<void> {
    for (const k of keys) {
      spawnSync('tmux', ['-L', this.outer, 'send-keys', '-t', `=${name}:`, k]);
      await sleep(150);
    }
  }

  async type(name: string, text: string): Promise<void> {
    spawnSync('tmux', ['-L', this.outer, 'send-keys', '-t', `=${name}:`, '-l', text]);
    await sleep(150);
  }

  screen(name: string): string {
    return execFileSync('tmux', ['-L', this.outer, 'capture-pane', '-p', '-t', `=${name}:`], {encoding: 'utf8'});
  }

  /** 画面に `pattern` が出るまで待つ。出なければ画面を添えて失敗する。 */
  async waitFor(name: string, pattern: RegExp | string, timeout = 10000): Promise<string> {
    const re = typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : pattern;
    const end = Date.now() + timeout;
    let last = '';
    while (Date.now() < end) {
      last = this.screen(name);
      if (re.test(last)) return last;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${re} on ${name}:\n${last}`);
  }

  async waitGone(name: string, pattern: RegExp | string, timeout = 10000): Promise<string> {
    const re = typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : pattern;
    const end = Date.now() + timeout;
    let last = '';
    while (Date.now() < end) {
      last = this.screen(name);
      if (!re.test(last)) return last;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${re} to disappear on ${name}:\n${last}`);
  }

  /** 選んでいる行(`> ` で始まる行)。 */
  selected(name: string): string {
    return (
      this.screen(name)
        .split('\n')
        .find(l => l.startsWith('> '))
        ?.trim() ?? ''
    );
  }

  /** 一覧のカーソルを名前の行に合わせる。 */
  async select(name: string, session: string): Promise<void> {
    for (let i = 0; i < 30; i++) {
      if (new RegExp(`^> [│├└ ]*${session}\\b`).test(this.selected(name))) return;
      await this.keys(name, 'Up');
    }
    for (let i = 0; i < 60; i++) {
      if (new RegExp(`^> [│├└ ]*${session}\\b`).test(this.selected(name))) return;
      await this.keys(name, 'Down');
    }
    throw new Error(`could not select ${session}:\n${this.screen(name)}`);
  }

  /** 専用サーバの tmux を呼ぶ。 */
  tmux(...args: string[]): string {
    const r = spawnSync('tmux', ['-L', this.socket, ...args], {encoding: 'utf8'});
    return r.stdout ?? '';
  }

  clients(): {tty: string; session: string}[] {
    return this.tmux('list-clients', '-F', '#{client_tty} #{client_session}')
      .split('\n')
      .filter(Boolean)
      .map(l => {
        const [tty = '', session = ''] = l.split(' ');
        return {tty, session};
      });
  }

  sessions(): string[] {
    return this.tmux('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean);
  }

  stateFile(): unknown {
    const p = join(this.state, 'whatnext', `state-${this.socket}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined;
  }

  listPid(): number {
    return Number(this.tmux('show', '-gv', '@wn_pid').trim());
  }

  cleanup(): void {
    spawnSync('tmux', ['-L', this.socket, 'kill-server']);
    spawnSync('tmux', ['-L', this.outer, 'kill-server']);
    rmSync(this.root, {recursive: true, force: true});
    for (const s of [this.socket, this.outer]) rmSync(`/private/tmp/tmux-${process.getuid?.()}/${s}`, {force: true});
  }
}
