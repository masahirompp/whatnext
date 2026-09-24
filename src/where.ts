// Location summary for the WHERE column: repo, non-default branch, worktree, PR.
import path from 'node:path';
import { run } from './agents.js';

export type Git = { repoRoot: string; repo: string; sub: string; branch?: string; worktree: boolean };
export type Pr = { number: number; state: 'open' | 'draft' | 'merged' | 'closed' };

export async function gitInfo(cwd: string): Promise<Git | null> {
  const r = await run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (r.code !== 0) return null;
  const [top, gitDir, common] = r.stdout.trim().split('\n');
  if (!top || !gitDir || !common) return null;
  const worktree = path.resolve(gitDir) !== path.resolve(common);
  // The main repo's root is the parent of the common .git dir.
  const repoRoot = path.basename(common) === '.git' ? path.dirname(common) : top;
  const sub = path.relative(top, cwd);
  const br = await run('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = br.code === 0 ? br.stdout.trim() : undefined;
  let def: string | undefined;
  const d = await run('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (d.code === 0) def = d.stdout.trim().replace(/^origin\//, '');
  const isDefault = branch !== undefined && (def ? branch === def : branch === 'main' || branch === 'master');
  return {
    repoRoot, repo: path.basename(repoRoot), sub: sub.startsWith('..') ? '' : sub,
    branch: isDefault ? undefined : branch, worktree,
  };
}

export async function prFor(cwd: string, branch: string): Promise<Pr | null> {
  const r = await run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1',
    '--json', 'number,state,isDraft'], { cwd, timeout: 15000 });
  if (r.code !== 0) return null;
  try {
    const [p] = JSON.parse(r.stdout) as { number: number; state: string; isDraft: boolean }[];
    if (!p) return null;
    const s = p.state.toLowerCase();
    return { number: p.number, state: p.isDraft && s === 'open' ? 'draft' : (s as Pr['state']) };
  } catch {
    return null;
  }
}

export function whereText(cwd: string, g: Git | null | undefined): string {
  if (!g) return path.basename(cwd) || cwd;
  let s = g.sub ? `${g.repo}/${g.sub}` : g.repo;
  if (g.branch) s += ` ${g.branch}`;
  if (g.worktree) s += ' (wt)';
  return s;
}
