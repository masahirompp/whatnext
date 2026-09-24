// Working-directory candidates and filtering for `n`.
import { run } from './agents.js';
import { gitInfo } from './where.js';

export type Candidate = { path: string; label: string };

export async function candidates(startDir: string, cwds: string[]): Promise<Candidate[]> {
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
  const labels = shortLabels(out);
  return out.map((p, i) => ({ path: p, label: labels[i] }));
}

// The last path segment, widened to more parent segments only while another path shares it.
export function shortLabels(paths: string[]): string[] {
  const segs = paths.map((p) => p.split('/').filter(Boolean));
  const tail = (s: string[], k: number) => s.slice(-k).join('/');
  return paths.map((p, i) => {
    const s = segs[i];
    for (let k = 1; k < s.length; k++) {
      const mine = tail(s, k);
      if (!segs.some((o, j) => j !== i && tail(o, k) === mine)) return mine;
    }
    return p;
  });
}

// Keep candidates whose label contains the typed characters in order; contiguous matches first.
export function filter(items: Candidate[], q: string): Candidate[] {
  if (!q) return items;
  const ql = q.toLowerCase();
  const subseq = (c: Candidate) => {
    let i = 0;
    for (const ch of c.label.toLowerCase()) if (ch === ql[i]) i++;
    return i === ql.length;
  };
  const hits = items.filter(subseq);
  const contiguous = hits.filter((c) => c.label.toLowerCase().includes(ql));
  return [...contiguous, ...hits.filter((s) => !contiguous.includes(s))];
}
