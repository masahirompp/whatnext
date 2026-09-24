// 各行の cwd のリポジトリ、ブランチ、worktree かどうか、PR(#12)。PR は gh があれば使う(#15 でタップをやめたため)
import { execFile } from 'node:child_process';
import path from 'node:path';

export type GitInfo = {
  repo: string; // リポジトリ名。根より下で動いていれば相対パスを足す
  top: string; // 作業ツリーの根(worktree ならその worktree)
  branch: string | null; // detached なら短い SHA
  worktree: boolean;
  defaultBranch: string | null; // origin/HEAD が指すブランチ。分からなければ null
};

export type PrInfo = { number: number; state: 'open' | 'draft' | 'merged' | 'closed' };

function run(cmd: string, args: string[], cwd: string, timeout: number) {
  return new Promise<string | null>((resolve) => {
    execFile(cmd, args, { cwd, timeout }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

export async function gitInfo(cwd: string): Promise<GitInfo | null> {
  const out = await run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel', '--show-prefix', '--abbrev-ref', 'HEAD'],
    cwd,
    5000,
  );
  if (out === null) return null;
  const [gitDir, commonDir, top, prefix, ref] = out.split('\n');
  const root = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : top;
  let branch: string | null = ref && ref !== 'HEAD' ? ref : null;
  if (!branch) branch = (await run('git', ['rev-parse', '--short', 'HEAD'], cwd, 5000))?.trim() || null;
  const sub = prefix.replace(/\/$/, '');
  const originHead = (await run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], cwd, 5000))?.trim();
  const defaultBranch = originHead?.startsWith('origin/') ? originHead.slice('origin/'.length) : null;
  return { repo: path.basename(root) + (sub ? `/${sub}` : ''), top, branch, worktree: gitDir !== commonDir, defaultBranch };
}

export function isDefaultBranch(g: GitInfo): boolean {
  if (g.branch === null) return false;
  return g.defaultBranch ? g.branch === g.defaultBranch : g.branch === 'main' || g.branch === 'master';
}

// リポジトリ、ブランチ、worktree を1つにまとめる。既定のブランチは省く。
//   whatnext / whatnext:feat/x / whatnext:feat/x (wt)
export function summarizeWhere(g: GitInfo | null, cwd: string): string {
  if (!g) return cwd;
  let text = g.repo;
  if (g.branch && !isDefaultBranch(g)) text += `:${g.branch}`;
  if (g.worktree) text += ' (wt)';
  return text;
}

// gh があれば、ブランチに対応する最新の PR を返す。gh がない・認証していない・PR がないときは null
export async function prFor(top: string, branch: string): Promise<PrInfo | null> {
  const out = await run('gh', ['pr', 'list', '--state', 'all', '--head', branch, '--limit', '1', '--json', 'number,state,isDraft'], top, 15000);
  if (!out) return null;
  try {
    const pr = JSON.parse(out)[0];
    if (!pr) return null;
    const state = pr.state === 'OPEN' ? (pr.isDraft ? 'draft' : 'open') : pr.state === 'MERGED' ? 'merged' : 'closed';
    return { number: pr.number, state };
  } catch {
    return null;
  }
}
