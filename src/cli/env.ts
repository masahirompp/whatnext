import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {shq} from '../../lib/tmux/tmux.js';

// 起動の口が共有する値(ソケット、ポート、版、自分を動かすコマンド)。

export const DEFAULT_SOCKET = 'whatnext';
export const DEFAULT_PORT = 14318;
/** 一覧の自動の更新の間隔と、Usage を取り直す最短の間隔の既定(PRODUCT.md「更新」「Usage の表示」)。 */
export const DEFAULT_REFRESH_MS = 60_000;
export const DEFAULT_USAGE_MIN_MS = 60_000;

export interface Env {
  socket: string;
  port: number;
  version: string;
  /** `node` の実行ファイル。 */
  node: string;
  /** この cli の入口(`dist/src/cli.js`)。 */
  cli: string;
  /**
   * ダイジェストを有効にするか(既定で有効。`--no-digest` で切る)。起動の口は引数だけで決め(`cli.ts`)、環境からは決めない。
   * 一覧の役は、起動の口が `paneCommand` でいつも明示して渡す `WHATNEXT_DIGEST`(`1` か `0`)で知る。
   * 外から引き継いだ値で、意図せず切れたり入ったりしないようにする(#362、#363)。
   */
  digest: boolean;
  /** 一覧の自動の更新の間隔(ms)。テストが `WHATNEXT_REFRESH_MS` で短くする。 */
  refreshMs: number;
  /** Usage を取り直す最短の間隔(ms)。テストが `WHATNEXT_USAGE_MIN_MS` で短くする。 */
  usageMinMs: number;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): Env {
  return {
    socket: env.WHATNEXT_TMUX_SOCKET || DEFAULT_SOCKET,
    port: Number(env.WHATNEXT_PORT) || DEFAULT_PORT,
    version: packageVersion(),
    node: process.execPath,
    cli: cliPath(),
    digest: env.WHATNEXT_DIGEST !== '0',
    refreshMs: positiveMs(env.WHATNEXT_REFRESH_MS, DEFAULT_REFRESH_MS),
    usageMinMs: positiveMs(env.WHATNEXT_USAGE_MIN_MS, DEFAULT_USAGE_MIN_MS),
  };
}

/** テストのつまみの間隔(ms)。数でない、0 以下の値は既定にする。 */
function positiveMs(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** ダイジェストの mod の置き場所(パッケージの根の `mod/`。`dist/src/cli/` から3つ上)。 */
export function modDir(): string {
  const p = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'mod');
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
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

/**
 * whatnext を起動してはいけないシェル(whatnext の中の作業台、claude の Bash)で動いているか。
 * claude の Bash(`CLAUDECODE=1`)は、whatnext の中かどうかに関係なく断る。`--bg` のセッションの環境は常駐の daemon のもので、
 * whatnext の中で動いているかを確実には見分けられない(#300)。
 */
export function insideWhatnext(env: Env, pe: NodeJS.ProcessEnv = process.env): boolean {
  if (pe.WHATNEXT_ROLE) return true;
  if (pe.CLAUDECODE === '1') return true;
  const t = pe.TMUX;
  if (!t) return false;
  const sockPath = t.split(',')[0] ?? '';
  return sockPath.endsWith(`/${env.socket}`);
}

/** 動くことを確かめた最も古い tmux の版(3.5a)。これより古い版は起動を断る。 */
export const MIN_TMUX = '3.5';

/**
 * `tmux -V` の出力が MIN_TMUX より古い版か。版を読み取れない表記(`tmux master` など)は断らない。
 * tmux 3.4 は、オプションに置いた sh の `$p` を `\$p` にして返すので、tmux から一覧への知らせが届かず、
 * attach から戻るキーも作業台も黙って効かなくなる。3.5a と 3.6a ではこれが起きず、画面の通しも通ったので、3.5 を下限にする。
 */
export function tooOldTmux(versionOutput: string): boolean {
  const m = /^tmux (?:next-)?(\d+)\.(\d+)/.exec(versionOutput.trim());
  if (!m) return false;
  const [minMajor = 0, minMinor = 0] = MIN_TMUX.split('.').map(Number);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major < minMajor || (major === minMajor && minor < minMinor);
}

/** 一覧と案内のペインのコマンド(`env` で環境を渡す。ペインのシェルの起動処理で PATH が組み直されても効くように)。 */
export function paneCommand(env: Env, role: 'list' | 'guide', pe: NodeJS.ProcessEnv = process.env): string {
  const vars: Record<string, string | undefined> = {
    WHATNEXT_ROLE: role,
    WHATNEXT_TMUX_SOCKET: env.socket,
    WHATNEXT_PORT: String(env.port),
    // 一覧の役には、有効でも切るときでも値を明示して渡す(引き継いだ値を必ず上書きする)
    WHATNEXT_DIGEST: role === 'list' ? (env.digest ? '1' : '0') : undefined,
    PATH: pe.PATH,
    HOME: pe.HOME,
    XDG_STATE_HOME: pe.XDG_STATE_HOME,
    CLAUDE_CONFIG_DIR: pe.CLAUDE_CONFIG_DIR,
    WHATNEXT_DEBUG_LOG: pe.WHATNEXT_DEBUG_LOG,
    // テストのつまみ。既定のときは渡さない
    WHATNEXT_REFRESH_MS: role === 'list' && env.refreshMs !== DEFAULT_REFRESH_MS ? String(env.refreshMs) : undefined,
    WHATNEXT_USAGE_MIN_MS:
      role === 'list' && env.usageMinMs !== DEFAULT_USAGE_MIN_MS ? String(env.usageMinMs) : undefined,
    LANG: pe.LANG,
    LC_ALL: pe.LC_ALL,
  };
  const assigns = Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${shq(v as string)}`);
  return `exec env ${assigns.join(' ')} ${shq(env.node)} ${shq(env.cli)}`;
}

/** Ghostty の分割やタブに打ち込む `whatnext workbench`。`exec` は `splitWorkbench` と `tabWorkbench` が付けるので、ここでは付けない。 */
export function workbenchCommand(env: Pick<Env, 'node' | 'cli'>): string {
  return `${shq(env.node)} ${shq(env.cli)} workbench`;
}
