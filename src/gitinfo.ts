// 各行の cwd のリポジトリ、ブランチ、worktree かどうか(#12)。PR は statusline の JSON から取る(#15)
import { execFile } from 'node:child_process';
import path from 'node:path';

export type GitInfo = {
  repo: string; // リポジトリ名。根より下で動いていれば相対パスを足す
  top: string; // 作業ツリーの根(worktree ならその worktree)
  branch: string | null; // detached なら短い SHA
  worktree: boolean;
  defaultBranch: string | null; // origin/HEAD が指すブランチ。分からなければ null
};

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
