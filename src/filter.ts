import path from 'node:path';

function isSubsequence(q: string, s: string) {
  let i = 0;
  for (const ch of s) if (i < q.length && ch === q[i]) i++;
  return i === q.length;
}

/**
 * Keep items whose label contains the query's characters in order, or whose
 * path contains the query verbatim. Label hits come first; within them,
 * contiguous hits come first. Stable otherwise.
 */
export function filterItems<T>(items: T[], query: string, label: (t: T) => string, fullPath?: (t: T) => string): T[] {
  const q = query.toLowerCase();
  if (!q) return items;
  const scored: { t: T; score: number; i: number }[] = [];
  items.forEach((t, i) => {
    const l = label(t).toLowerCase();
    let score = -1;
    if (l.includes(q)) score = 0;
    else if (isSubsequence(q, l)) score = 1;
    else if (fullPath && fullPath(t).toLowerCase().includes(q)) score = 2;
    if (score >= 0) scored.push({ t, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.t);
}

/** Shortest distinguishing tail of each path: `foo`, or `a/foo` and `b/foo`. */
export function displayNames(paths: string[]): Map<string, string> {
  const parts = new Map(paths.map((p) => [p, p.split(path.sep).filter(Boolean)]));
  const depth = new Map(paths.map((p) => [p, 1]));
  const tail = (p: string) => parts.get(p)!.slice(-depth.get(p)!).join('/') || p;
  for (let round = 0; round < 20; round++) {
    const byName = new Map<string, string[]>();
    for (const p of paths) {
      const n = tail(p);
      byName.set(n, [...(byName.get(n) ?? []), p]);
    }
    let changed = false;
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      for (const p of group) {
        if (depth.get(p)! < parts.get(p)!.length) {
          depth.set(p, depth.get(p)! + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return new Map(paths.map((p) => [p, tail(p)]));
}
