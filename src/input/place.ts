// 入力: 場所(リポジトリ、ブランチ、worktree)を `git` で、PR を `gh` で取る。

import {basename, dirname, relative} from 'node:path';
import type {Run} from './exec.js';

export interface Place {
  /** リポジトリ名(`repo/sub`)か、git でない場所のパスの末尾。 */
  repo: string;
  /** 今チェックアウトされているブランチ(切り離された HEAD なら undefined)。 */
  branch?: string;
  /** 既定のブランチと違うか。 */
  nonDefault: boolean;
  worktree: boolean;
  /** `cwd` が属するチェックアウトの根(git でなければ `cwd`)。 */
  checkoutRoot: string;
  /** 元のリポジトリの根(worktree なら元のリポジトリ。git でなければ `cwd`)。 */
  mainRoot: string;
  git: boolean;
}

export async function placeOf(run: Run, cwd: string): Promise<Place> {
  const plain: Place = {
    repo: basename(cwd) || cwd,
    nonDefault: false,
    worktree: false,
    checkoutRoot: cwd,
    mainRoot: cwd,
    git: false,
  };
  const r = await run(
    'git',
    ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'],
    {timeout: 5000},
  );
  if (r.code !== 0) return plain;
  const [top, common, head] = r.stdout.trim().split('\n');
  if (!top || !common) return plain;
  const mainRoot = basename(common) === '.git' ? dirname(common) : common;
  const sub = relative(top, cwd);
  const repo = basename(mainRoot) + (sub && !sub.startsWith('..') ? `/${sub}` : '');
  const branch = head && head !== 'HEAD' ? head : undefined;
  let nonDefault = false;
  if (branch) {
    const d = await run('git', ['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {timeout: 5000});
    const def = d.code === 0 ? d.stdout.trim().replace(/^[^/]+\//, '') : undefined;
    nonDefault = def ? branch !== def : branch !== 'main' && branch !== 'master';
  }
  return {repo, branch, nonDefault, worktree: top !== mainRoot, checkoutRoot: top, mainRoot, git: true};
}

export interface PullRequest {
  number: number;
  state: 'open' | 'draft' | 'merged' | 'closed';
  url: string;
}

/** そのブランチを head に持つ最新の PR。`gh` がない、認証していない、PR がないときは undefined。 */
export async function pullRequestOf(run: Run, cwd: string, branch: string): Promise<PullRequest | undefined> {
  const r = await run(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state,isDraft,url'],
    {cwd, timeout: 15000},
  );
  if (r.code !== 0) return undefined;
  try {
    const list = JSON.parse(r.stdout) as {number: number; state: string; isDraft: boolean; url: string}[];
    const p = list[0];
    if (!p) return undefined;
    const state =
      p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : ('open' as const);
    return {number: p.number, state, url: p.url};
  } catch {
    return undefined;
  }
}

/** github.com の PR の URL から vscode.dev の URL を作る。github.com でなければ undefined。 */
export function vscodeDevUrl(prUrl: string): string | undefined {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(prUrl);
  return m ? `https://vscode.dev/github/${m[1]}/${m[2]}/pull/${m[3]}` : undefined;
}
