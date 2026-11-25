import {statSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {type Run, stripControl} from '../../lib/input/exec.js';

// セッションを `claude --bg` で起動するときの部品。一覧の `n`(`app.ts`)と `whatnext new`(`src/cli/new.ts`)が共有する。
// 起動のあと(attach するか、id を出して終わるか)と、信頼されていないときの扱いは、呼ぶ側が決める。

/** セッションに付けるもの(`--settings` はフックと OTel、`--plugin-dir` はダイジェストの mod)。付けないものは undefined。 */
export interface Attachments {
  settings?: string;
  pluginDir?: string;
}

/**
 * `claude --bg` の引数。指示は `--` の後ろに置く(前に置くと、複数の値を取るオプションが指示まで値として飲み込む。
 * docs/claude-code-behavior.md)。指示がなければ、最初のターンを始めずに起動する(`n`)。
 */
export function bgArgs(a: Attachments, prompt?: string): string[] {
  const args = ['--bg'];
  if (a.settings) args.push('--settings', a.settings);
  if (a.pluginDir) args.push('--plugin-dir', a.pluginDir);
  if (prompt !== undefined) args.push('--', prompt);
  return args;
}

/** `claude --bg` の結果。`out` は制御列を除いた出力(失敗の表示に使う)。 */
export type BgResult = {k: 'started'; id: string} | {k: 'untrusted'; out: string} | {k: 'failed'; out: string};

/**
 * `claude --bg` の出力(標準出力と標準エラー)から、起動できたか、信頼されていないディレクトリかを読む。
 * `afterTrust` は、信頼の確認のあとのやり直し(`n`)。このときは信頼の文言を見ず、`backgrounded · <id>` があれば起動できたと読む
 * (文言と id の両方がある出力でも、起動したセッションを失敗の画面にしない。#358 の前の `n` と同じ)。
 */
export function readBgOutput(stdout: string, stderr: string, opts: {afterTrust?: boolean} = {}): BgResult {
  const out = stripControl(`${stdout}${stderr}`);
  if (!opts.afterTrust && /Workspace not trusted/i.test(out)) return {k: 'untrusted', out};
  const m = /backgrounded\s*·\s*([0-9a-f]{8})/.exec(out);
  return m ? {k: 'started', id: m[1]} : {k: 'failed', out};
}

/** `claude --bg` の待ち時間の上限(ms)。 */
export const BG_TIMEOUT_MS = 120_000;

/** 先頭の `~` を home に展開する(`~` と `~/…` だけ。`~user` は展開しない)。 */
export function expandHome(text: string, home: string): string {
  return text === '~' ? home : text.startsWith('~/') ? `${home}${text.slice(1)}` : text;
}

/**
 * 既存のディレクトリなら、末尾の `/` を除いた絶対パスを返す。`~` を展開する。相対パスは `base` があるときだけ受け、
 * `base` から解く(`n` の Other... は base を渡さず、絶対パスだけを受ける)。
 */
export function existingDir(text: string, home: string, base?: string): string | undefined {
  const expanded = expandHome(text, home);
  if (!isAbsolute(expanded) && base === undefined) return undefined;
  const p = isAbsolute(expanded) ? expanded : resolve(base ?? '/', expanded);
  try {
    if (statSync(p).isDirectory()) return p.replace(/\/+$/, '') || '/';
  } catch {}
  return undefined;
}

/** `ghq list -p` のパス(重なりは除く)。ghq が無い、または失敗したときは undefined。 */
export async function ghqPaths(run: Run): Promise<string[] | undefined> {
  const r = await run('ghq', ['list', '-p'], {timeout: 10000});
  if (r.code !== 0) return undefined;
  const out: string[] = [];
  for (const l of r.stdout.split('\n')) {
    const p = l.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
