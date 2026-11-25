import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {type Run, run} from '../../lib/input/exec.js';
import {type Occupant, probe} from '../../lib/input/receiver.js';
import {sessionFailureLines} from '../ops/app.js';
import {BG_TIMEOUT_MS, bgArgs, existingDir, ghqPaths, readBgOutput} from '../ops/start.js';
import {
  attachmentsFor,
  decideAttachments,
  digestEnv,
  locateTmux,
  socketPathOf,
  TMUX_DIRS,
  withDigestEnv,
} from './attachments.js';
import {type Env, tmuxEnv} from './env.js';

// `whatnext new <ディレクトリかリポジトリ名> <指示>`(PRODUCT.md「一覧の外からの起動」、ADR-0024)。
// 一覧の外(端末のないスクリプトなど)から、`n` と同じものを付けたセッションを `claude --bg -- <指示>` で起動し、
// id を出してすぐ終わる。端末も tmux も使わない。

export const NEW_USAGE = 'Usage: whatnext new <directory|repository> <prompt>\n';

/** 外に触れる口(テストが差し替える)。 */
export interface NewPorts {
  run: Run;
  probe: (port: number) => Promise<Occupant>;
  /** tmux の実行ファイルの絶対パスを、PATH の形の文字列から探す。なければ undefined。 */
  findTmux: (path: string) => string | undefined;
  /** 専用サーバのソケットが、そのパスにあるか。 */
  socketExists: (path: string) => boolean;
  pe: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  out: (s: string) => void;
  err: (s: string) => void;
}

const realPorts = (): NewPorts => ({
  run,
  probe,
  // 呼ぶ側の PATH に無ければ、よくある置き場所も探す(ランチャーの PATH は短い)
  findTmux: path => locateTmux(path, TMUX_DIRS),
  socketExists: existsSync,
  pe: process.env,
  cwd: process.cwd(),
  home: homedir(),
  out: s => process.stdout.write(s),
  err: s => process.stderr.write(s),
});

/**
 * パスとして書かれた引数か(リポジトリ名として探さない)。`/`、`~`、`./`、`../` で始まるものと、`.`、`..`。`~user` も
 * パスとみなす(展開はしないので、`Not a directory` になる)。`.github` のような名前は、パスとみなさない。
 */
function pathLike(arg: string): boolean {
  return arg.startsWith('/') || arg.startsWith('~') || /^\.\.?(\/|$)/.test(arg);
}

/** `ghq list -p` のパスのうち、末尾が名前に一致するもの(`name`、`owner/name`、`github.com/owner/name`)。 */
export function matchRepos(paths: readonly string[], name: string): string[] {
  const n = name.replace(/^\/+|\/+$/g, '');
  if (!n) return [];
  return paths.filter(p => p === n || p.endsWith(`/${n}`));
}

/**
 * 起動するディレクトリを決める。既存のディレクトリ(`~` を展開する。相対パスは今の場所から解く)が先で、
 * そうでなければ `ghq list -p` のパスに末尾で一致するリポジトリを探す。決まらなければ、標準エラーに出す行を返す。
 */
export async function resolveTarget(
  arg: string,
  p: Pick<NewPorts, 'run' | 'cwd' | 'home'>,
): Promise<{dir: string} | {error: string[]}> {
  const dir = existingDir(arg, p.home, p.cwd);
  if (dir) return {dir};
  if (pathLike(arg)) return {error: [`Not a directory: ${arg}`]};
  const paths = await ghqPaths(p.run);
  if (!paths) return {error: [`Not a directory: ${arg} (repository names need ghq, and "ghq list -p" failed)`]};
  const found = matchRepos(paths, arg);
  if (found.length === 1) return {dir: found[0]};
  if (found.length === 0) return {error: [`No such repository: ${arg}`]};
  return {error: [`Ambiguous: ${arg}`, ...found.map(f => `  ${f}`)]};
}

/**
 * `claude` に渡す環境。`WHATNEXT_*` と、tmux の `TMUX`、`TMUX_PANE` を外す。claude のデーモンは、それを起こしたプロセスの
 * 環境を持ち続け、そのあとのすべての `--bg` のセッションに渡す(#363)。作業台のシェルから呼ぶと、`TMUX` は専用サーバを指す。
 * 一覧の `n` も、`TMUX` と `TMUX_PANE` を外した環境(`tmuxEnv`)で claude を動かす。
 */
export function claudeEnv(pe: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(tmuxEnv(pe))) if (!k.startsWith('WHATNEXT_')) out[k] = v;
  return out;
}

/**
 * 受け口のポートの状態。`other` のときは、もう一度だけ確かめる。`probe` は、応答が1秒より遅れたときも `other` と答えるので、
 * 動いている一覧の応答が1回遅れただけで「ほかのプログラム」と決めると、何も付けずに起動してしまう(付けるものは起動時に固定)。
 * ほかのプログラムはすぐに答えるので、確かめ直しても待たせない。
 */
async function occupantOf(p: Pick<NewPorts, 'probe'>, port: number): Promise<Occupant> {
  const first = await p.probe(port);
  return first === 'other' ? p.probe(port) : first;
}

export async function newSession(
  env: Pick<Env, 'port' | 'socket'>,
  a: {target: string; prompt: string},
  p: NewPorts = realPorts(),
): Promise<number> {
  // claude の Bash からは断る(sandbox の中では claude が claude を起動できない。`whatnext` と同じ見分け方。#300)
  if (p.pe.CLAUDECODE === '1') {
    p.err('whatnext: whatnext new cannot run inside a Claude Code session. Run it from a shell or a script.\n');
    return 1;
  }
  const target = await resolveTarget(a.target, p);
  if ('error' in target) {
    p.err(`whatnext: ${target.error.join('\n')}\n`);
    return 1;
  }

  const occupant = await occupantOf(p, env.port);
  const attached = attachmentsFor(env.port, decideAttachments(occupant, {who: 'new'}));
  // mod は、渡した tmux で一覧に「受けているか」を問う。セッションの PATH に tmux があるとは限らないので、絶対パスで渡す
  let tmux: string | undefined;
  let socketPath: string | undefined;
  if (attached.settings && attached.pluginDir) {
    tmux = p.findTmux(p.pe.PATH ?? '');
    // 一覧が動いていなくても組める値だけを渡す。mod は、一覧がダイジェストを受けている間だけ Haiku を呼ぶ
    socketPath = socketPathOf(env.socket, p.pe);
    attached.settings = withDigestEnv(attached.settings, digestEnv(env.port, socketPath, tmux ?? 'tmux'));
  }
  // 一覧が動いているのに、組んだパスに専用サーバのソケットが無い(呼ぶ側の `TMUX_TMPDIR` が、一覧の端末のものと違う)。
  // 一覧が動いていないとき(`free`)は、ソケットが無いのが普通なので、見ない
  const lostSocket =
    occupant === 'whatnext' && socketPath !== undefined && !p.socketExists(socketPath) ? socketPath : undefined;

  const r = await p.run('claude', bgArgs(attached, a.prompt), {
    cwd: target.dir,
    timeout: BG_TIMEOUT_MS,
    env: claudeEnv(p.pe),
  });
  const res = readBgOutput(r.stdout, r.stderr);
  if (res.k === 'untrusted') {
    // 端末がないので、信頼の確認は出せない
    p.err(`whatnext: Not trusted: ${target.dir}. Run claude there once and accept the trust prompt.\n`);
    return 1;
  }
  if (res.k === 'failed') {
    p.err(`whatnext: ${sessionFailureLines(res.out, r.error).join('\n')}\n`);
    return 1;
  }
  if (occupant === 'other') {
    p.err(
      `whatnext: port ${env.port} is used by another program. Started the session without hooks, so the list shows no context size or digest for it.\n`,
    );
  }
  if (attached.pluginDir && !tmux) {
    // 素の `tmux` を渡した。設定は起動時に固定なので、セッションが tmux を動かせなければ、ダイジェストはあとからも出ない
    p.err(
      'whatnext: tmux not found on PATH. Started the session, but its digest shows in the list only if the session can run tmux.\n',
    );
  }
  if (lostSocket) {
    // mod は、このパスで一覧に「受けているか」を問う。設定は起動時に固定なので、ダイジェストはあとからも出ない
    p.err(
      `whatnext: the list is running, but its tmux socket is not at ${lostSocket}. Started the session, but its digest will not show in the list. Check that TMUX_TMPDIR here matches the list's terminal.\n`,
    );
  }
  p.out(`${res.id}\n`);
  return 0;
}
