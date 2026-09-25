// Location summary for the WHERE column: repo, non-default branch, worktree, PR.
import os from 'node:os';
import path from 'node:path';
import { run } from './agents.js';

// top: the checkout the cwd is in (the worktree itself when in one); repoRoot: the main repo.
export type Git = { top: string; repoRoot: string; repo: string; sub: string; branch?: string; worktree: boolean };
export type Pr = { number: number; state: 'open' | 'draft' | 'merged' | 'closed'; url: string };

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
    top, repoRoot, repo: path.basename(repoRoot), sub: sub.startsWith('..') ? '' : sub,
    branch: isDefault ? undefined : branch, worktree,
  };
}

export async function prFor(cwd: string, branch: string): Promise<Pr | null> {
  const r = await run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1',
    '--json', 'number,state,isDraft,url'], { cwd, timeout: 15000 });
  if (r.code !== 0) return null;
  try {
    const [p] = JSON.parse(r.stdout) as { number: number; state: string; isDraft: boolean; url: string }[];
    if (!p) return null;
    const s = p.state.toLowerCase();
    return { number: p.number, state: p.isDraft && s === 'open' ? 'draft' : (s as Pr['state']), url: p.url };
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

// https://github.com/<owner>/<repo>/pull/<n> -> https://vscode.dev/github/<owner>/<repo>/pull/<n>
export function vscodeDevUrl(prUrl: string): string | null {
  const m = prUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+\/pull\/\d+)/);
  return m ? `https://vscode.dev/github/${m[1]}` : null;
}

// Opens a folder in local VS Code through its URL handler, so only the OS `open` is needed (ADR-0004).
export const vscodeFolderUrl = (dir: string) => `vscode://file${encodeURI(dir)}/`;

export type OpenTarget = { label: string; url: string };

// What `e` (external) offers for a row: the checkout in local VS Code (the worktree when in one), then the PR.
export function openTargets(cwd: string, git: Git | null | undefined, pr: Pr | null | undefined): OpenTarget[] {
  const dir = git?.top ?? cwd;
  const home = os.homedir();
  const shown = dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
  const out: OpenTarget[] = [{ label: `VS Code: ${shown}`, url: vscodeFolderUrl(dir) }];
  if (!pr) return out;
  const dev = vscodeDevUrl(pr.url);
  if (dev) out.push({ label: `PR #${pr.number} on vscode.dev`, url: dev });
  out.push({ label: `PR #${pr.number} on GitHub`, url: pr.url });
  return out;
}
