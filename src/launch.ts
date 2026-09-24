// Working-directory candidates and filtering for `n`.
import { run } from './agents.js';
import { gitInfo } from './where.js';

export async function candidates(startDir: string, cwds: string[]): Promise<string[]> {
  const out: string[] = [];
  const add = (p: string) => { if (p && !out.includes(p)) out.push(p); };
  add(startDir);
  for (const c of cwds) {
    const g = await gitInfo(c);
    // A session that moved into a worktree is pulled back to its main repo.
    add(g?.worktree ? g.repoRoot : c);
  }
  const r = await run('ghq', ['list', '-p'], { timeout: 10000 });
  if (r.code === 0) for (const line of r.stdout.split('\n')) add(line.trim());
  return out;
}

// Keep candidates containing the typed characters in order; contiguous matches first.
export function filter(items: string[], q: string): string[] {
  if (!q) return items;
  const ql = q.toLowerCase();
  const subseq = (s: string) => {
    let i = 0;
    for (const ch of s.toLowerCase()) if (ch === ql[i]) i++;
    return i === ql.length;
  };
  const hits = items.filter(subseq);
  const contiguous = hits.filter((s) => s.toLowerCase().includes(ql));
  return [...contiguous, ...hits.filter((s) => !contiguous.includes(s))];
}
