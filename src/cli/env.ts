import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {shq} from '../../lib/tmux/tmux.js';

// 起動の口が共有する値(ソケット、ポート、版、自分を動かすコマンド)。

export const DEFAULT_SOCKET = 'whatnext';
export const DEFAULT_PORT = 14318;

export interface Env {
  socket: string;
  port: number;
  version: string;
  /** `node` の実行ファイル。 */
  node: string;
  /** この cli の入口(`dist/src/cli.js`)。 */
  cli: string;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): Env {
  return {
    socket: env.WHATNEXT_TMUX_SOCKET || DEFAULT_SOCKET,
    port: Number(env.WHATNEXT_PORT) || DEFAULT_PORT,
    version: packageVersion(),
    node: process.execPath,
    cli: cliPath(),
  };
}

function cliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const p = join(here, '..', 'cli.js');
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

let cachedVersion: string | undefined;
export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'package.json');
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, 'utf8')) as {name?: string; version?: string};
        if (j.name === '@masahirompp/whatnext' && j.version) {
          cachedVersion = j.version;
          return j.version;
        }
      } catch {}
    }
    dir = dirname(dir);
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}

/** 自分の端末の tty(`tty` の出力。`#{client_tty}` と同じ形)。 */
export function myTty(): string | undefined {
  const r = spawnSync('tty', [], {stdio: ['inherit', 'pipe', 'ignore']});
  const s = r.stdout?.toString().trim();
  return r.status === 0 && s?.startsWith('/') ? s : undefined;
}

/** 専用の tmux に渡す環境(利用者の tmux の `TMUX` を外す)。 */
export function tmuxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = {...env};
  delete out.TMUX;
  delete out.TMUX_PANE;
  return out;
}

/** whatnext の中のシェル(作業台、claude の画面)で動いているか。 */
export function insideWhatnext(env: Env, pe: NodeJS.ProcessEnv = process.env): boolean {
  if (pe.WHATNEXT_ROLE) return true;
  const t = pe.TMUX;
  if (!t) return false;
  const sockPath = t.split(',')[0] ?? '';
  return sockPath.endsWith(`/${env.socket}`);
}

/** 一覧と案内のペインのコマンド(`env` で環境を渡す。ペインのシェルの起動処理で PATH が組み直されても効くように)。 */
export function paneCommand(env: Env, role: 'list' | 'guide', pe: NodeJS.ProcessEnv = process.env): string {
  const vars: Record<string, string | undefined> = {
    WHATNEXT_ROLE: role,
    WHATNEXT_TMUX_SOCKET: env.socket,
    WHATNEXT_PORT: String(env.port),
    PATH: pe.PATH,
    HOME: pe.HOME,
    XDG_STATE_HOME: pe.XDG_STATE_HOME,
    CLAUDE_CONFIG_DIR: pe.CLAUDE_CONFIG_DIR,
    WHATNEXT_DEBUG_LOG: pe.WHATNEXT_DEBUG_LOG,
    LANG: pe.LANG,
    LC_ALL: pe.LC_ALL,
  };
  const assigns = Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${shq(v as string)}`);
  return `exec env ${assigns.join(' ')} ${shq(env.node)} ${shq(env.cli)}`;
}
