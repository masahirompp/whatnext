// cli: `whatnext`(一覧につなぐ)と `whatnext workbench`(作業台の画面としてつなぐ)。

import {spawnSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {run} from '../input/exec.js';
import {probe} from '../input/receiver.js';
import {GUIDE, LIST, shq, Tmux} from '../tmux/tmux.js';
import type {Settings} from './args.js';

function ttyName(): string | undefined {
  const r = spawnSync('tty', {stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8'});
  const t = r.stdout?.trim();
  return t?.startsWith('/dev/') ? t : undefined;
}

/** 起動したディレクトリ。シンボリックリンクを解く前の `PWD` が同じ場所を指していれば、そちらを使う。 */
function startDir(): string {
  const pwd = process.env.PWD;
  try {
    if (pwd && realpathSync(pwd) === process.cwd()) return pwd;
  } catch {}
  return process.cwd();
}

function childEnv(): NodeJS.ProcessEnv {
  const env = {...process.env};
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

/** 専用サーバにつなぎ、離れるまで待つ。tmux が終わるときに書く1行(`[detached ...]`、`[server exited]`)は消す。 */
function attach(socket: string, target: string): void {
  spawnSync('tmux', ['-L', socket, 'attach-session', '-t', `=${target}`], {stdio: 'inherit', env: childEnv()});
  if (process.stdout.isTTY) process.stdout.write('\x1b[1A\x1b[2K');
}

const fail = (msg: string, code = 1): number => {
  process.stderr.write(`${msg}\n`);
  return code;
};

async function hasTmux(): Promise<boolean> {
  const r = await run('tmux', ['-V'], {timeout: 5000});
  return r.code === 0;
}

const TMUX_MISSING = 'whatnext: tmux is required but was not found. Install tmux and run whatnext again.';

/** `whatnext`: 一覧があればつなぎ、なければ専用の tmux サーバで一覧を動かしてからつなぐ。 */
export async function launch(s: Settings, version: string, cliPath: string): Promise<number> {
  if (!(await hasTmux())) return fail(TMUX_MISSING);
  const tmux = new Tmux(s.socket, run);
  const tty = ttyName();
  if (!tty) return fail('whatnext: run it in a terminal.');
  if (await tmux.hasSession(LIST)) {
    const running = await tmux.option('@wn_version');
    if (running && running !== version) await tmux.setOption('@wn_newer', version);
  } else {
    const occupant = await probe(s.port);
    if (occupant === 'whatnext')
      return fail(`whatnext: another whatnext is already running (port ${s.port}). Quit it first.`);
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const cmd = `exec ${shq(process.execPath)} ${shq(cliPath)}`;
    const r = await run(
      'tmux',
      [
        '-L',
        s.socket,
        '-f',
        '/dev/null',
        'new-session',
        '-d',
        '-s',
        LIST,
        '-x',
        String(cols),
        '-y',
        String(rows),
        '-e',
        'WHATNEXT_ROLE=list',
        '-e',
        `WHATNEXT_START_DIR=${startDir()}`,
        '-e',
        `WHATNEXT_TMUX_SOCKET=${s.socket}`,
        '-e',
        `WHATNEXT_PORT=${s.port}`,
        cmd,
        ';',
        'set',
        '-s',
        'terminal-features[90]',
        'xterm*:RGB:hyperlinks',
        ';',
        'set',
        '-g',
        '@wn_main_tty',
        tty,
      ],
      {env: childEnv(), timeout: 10000},
    );
    if (r.code !== 0) return fail(`whatnext: could not start tmux: ${r.stderr.trim()}`);
  }
  await claimClient(tmux, '@wn_main_tty', '@wn_wb_tty', tty);
  attach(s.socket, LIST);
  return 0;
}

/** つなぐ端末の印を置き、同じ役の古いクライアントを離す。もう一方の印が自分と同じ tty なら消す(tty の使い回し)。 */
async function claimClient(tmux: Tmux, mine: string, other: string, tty: string): Promise<void> {
  const otherTty = await tmux.option(other);
  if (otherTty === tty) await tmux.unsetOption(other);
  await tmux.setOption(mine, tty);
  for (const c of await tmux.clients()) {
    if (c.tty === tty) continue;
    if (otherTty && c.tty === otherTty && otherTty !== tty) continue;
    await tmux.detachClient(c.tty);
  }
}

/** `whatnext workbench`: 専用サーバの2つ目のクライアントとしてつなぐ。 */
export async function workbench(s: Settings): Promise<number> {
  if (!(await hasTmux())) return fail(TMUX_MISSING);
  const tmux = new Tmux(s.socket, run);
  if (!(await tmux.hasSession(LIST))) return fail('whatnext is not running. Start whatnext first.');
  const tty = ttyName();
  if (!tty) return fail('whatnext: run it in a terminal.');
  for (let i = 0; i < 20 && !(await tmux.hasSession(GUIDE)); i++) await new Promise(r => setTimeout(r, 100));
  await claimClient(tmux, '@wn_wb_tty', '@wn_main_tty', tty);
  attach(s.socket, GUIDE);
  // 古いタイトルの分割へ移らないよう、終わるときにタイトルを消す。
  process.stdout.write('\x1b]2;\x07');
  return 0;
}
