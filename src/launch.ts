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

// Keep candidates whose label contains the typed characters in order (contiguous first),
// then those whose full path contains them contiguously. Scattered matches on a long
// path would let almost any query hit every candidate, so the path needs contiguity.
export function filter(items: Candidate[], q: string): Candidate[] {
  if (!q) return items;
  const ql = q.toLowerCase();
  const subseq = (s: string) => {
    let i = 0;
    for (const ch of s.toLowerCase()) if (ch === ql[i]) i++;
    return i === ql.length;
  };
  const ranked: [number, Candidate][] = [];
  for (const c of items) {
    if (c.label.toLowerCase().includes(ql)) ranked.push([0, c]);
    else if (subseq(c.label)) ranked.push([1, c]);
    else if (c.path.toLowerCase().includes(ql)) ranked.push([2, c]);
  }
  return ranked.sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}
