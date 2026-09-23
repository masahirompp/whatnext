// 各行の cwd のリポジトリ、ブランチ、worktree かどうか、PR(#12)
import { execFile } from 'node:child_process';
import path from 'node:path';

export type GitInfo = {
  repo: string; // リポジトリ名。根より下で動いていれば相対パスを足す
  top: string; // 作業ツリーの根(worktree ならその worktree)
  branch: string | null; // detached なら短い SHA
  worktree: boolean;
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
  return { repo: path.basename(root) + (sub ? `/${sub}` : ''), top, branch, worktree: gitDir !== commonDir };
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
