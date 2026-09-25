import path from 'node:path';
import { run } from './exec.js';

export type PR = { number: number; state: 'open' | 'draft' | 'merged' | 'closed'; url: string };
export type Where = {
  repo: string; // display: repo, repo/sub, or path tail
  repoRoot?: string; // main repository root (worktrees folded back)
  checkoutRoot?: string; // top of the checkout the cwd is in (worktree or repo)
  branch?: string; // only when not the default branch
  worktree: boolean;
  pr?: PR | null; // undefined = not fetched yet, null = none
};

async function git(cwd: string, ...args: string[]) {
  const r = await run('git', ['-C', cwd, ...args], { timeoutMs: 5000 });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function gitInfo(cwd: string): Promise<Where> {
  const top = await git(cwd, 'rev-parse', '--show-toplevel');
  if (!top) return { repo: path.basename(cwd) || cwd, worktree: false, checkoutRoot: cwd };
  const common = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const repoRoot = common && path.basename(common) === '.git' ? path.dirname(common) : top;
  const worktree = path.resolve(repoRoot) !== path.resolve(top);
  const rel = path.relative(top, cwd);
  const repoName = path.basename(repoRoot);
  const repo = rel && !rel.startsWith('..') ? `${repoName}/${rel}` : repoName;
  const head = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  let branch = head && head !== 'HEAD' ? head : undefined;
  if (branch) {
    const def = await defaultBranch(cwd);
    if (branch === def) branch = undefined;
  }
  return { repo, repoRoot, checkoutRoot: top, branch, worktree };
}

async function defaultBranch(cwd: string) {
  const ref = await git(cwd, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
  if (ref) return ref.replace(/^refs\/remotes\/origin\//, '');
  for (const b of ['main', 'master']) {
    if (await git(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`)) return b;
  }
  return undefined;
}

/** Latest PR whose head is the branch. null when none or gh is unavailable. */
export async function fetchPR(cwd: string, branch: string): Promise<PR | null> {
  const r = await run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state,isDraft,url'], {
    cwd,
    timeoutMs: 15000,
  });
  if (r.code !== 0) return null;
  try {
    const [p] = JSON.parse(r.stdout) as { number: number; state: string; isDraft: boolean; url: string }[];
    if (!p) return null;
    const state = p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : 'open';
    return { number: p.number, state, url: p.url };
  } catch {
    return null;
  }
}

/** Repository root to offer as a working directory (worktrees folded back). */
export async function repoRootOf(cwd: string) {
  const w = await gitInfo(cwd);
  return w.repoRoot ?? cwd;
}
