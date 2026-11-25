import {homedir} from 'node:os';
import {type Run, run} from '../../lib/input/exec.js';
import {type Occupant, probe} from '../../lib/input/receiver.js';
import {sessionFailureLines} from '../ops/app.js';
import {BG_TIMEOUT_MS, bgArgs, existingDir, ghqPaths, readBgOutput} from '../ops/start.js';
import {attachmentsFor, decideAttachments, digestEnv, socketPathOf, withDigestEnv} from './attachments.js';
import type {Env} from './env.js';

// `whatnext new <ディレクトリかリポジトリ名> <指示>`(PRODUCT.md「一覧の外からの起動」、ADR-0024)。
// 一覧の外(端末のないスクリプトなど)から、`n` と同じものを付けたセッションを `claude --bg -- <指示>` で起動し、
// id を出してすぐ終わる。端末も tmux も使わない。

export const NEW_USAGE = 'Usage: whatnext new <directory|repository> <prompt>\n';

/** 外に触れる口(テストが差し替える)。 */
export interface NewPorts {
  run: Run;
  probe: (port: number) => Promise<Occupant>;
  pe: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  out: (s: string) => void;
  err: (s: string) => void;
}

const realPorts = (): NewPorts => ({
  run,
  probe,
  pe: process.env,
  cwd: process.cwd(),
  home: homedir(),
  out: s => process.stdout.write(s),
  err: s => process.stderr.write(s),
});

/** パスとして書かれた引数か(リポジトリ名として探さない)。`.github` のような名前は、パスとみなさない。 */
function pathLike(arg: string): boolean {
  return arg.startsWith('/') || arg === '~' || arg.startsWith('~/') || /^\.\.?(\/|$)/.test(arg);
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
 * `claude` に渡す環境。`WHATNEXT_*` を外す。claude のデーモンは、それを起こしたプロセスの環境を持ち続け、そのあとの
 * すべての `--bg` のセッションに渡す(#363)。
 */
export function claudeEnv(pe: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(pe)) if (!k.startsWith('WHATNEXT_')) out[k] = v;
  return out;
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

  const occupant = await p.probe(env.port);
  const attached = attachmentsFor(env.port, decideAttachments(occupant, {who: 'new'}));
  if (attached.settings && attached.pluginDir) {
    // 一覧が動いていなくても組める値だけを渡す。mod は、一覧がダイジェストを受けている間だけ Haiku を呼ぶ
    attached.settings = withDigestEnv(attached.settings, digestEnv(env.port, socketPathOf(env.socket, p.pe)));
  }

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
  p.out(`${res.id}\n`);
  return 0;
}
