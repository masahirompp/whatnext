// 操作: 候補の表示名と絞り込み(`n` の作業ディレクトリと `f` のメニュー)。

import {sep} from 'node:path';

/** 末尾のディレクトリ名で表示し、同じ名前があれば区別できるところまで親を足す。 */
export function displayNames(paths: readonly string[]): string[] {
  const parts = paths.map(p => p.split(sep).filter(Boolean));
  const depth = paths.map(() => 1);
  for (let round = 0; round < 64; round++) {
    const names = parts.map((ps, i) => ps.slice(-(depth[i] as number)).join('/') || '/');
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    let changed = false;
    names.forEach((n, i) => {
      if ((counts.get(n) ?? 0) > 1 && (depth[i] as number) < (parts[i] as string[]).length) {
        depth[i] = (depth[i] as number) + 1;
        changed = true;
      }
    });
    if (!changed) return names;
  }
  return parts.map((ps, i) => ps.slice(-(depth[i] as number)).join('/'));
}

function subsequence(q: string, s: string): boolean {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i >= q.length;
}

/**
 * 打った文字で絞り込む。表示名は文字を順に含めば当たり、フルパスは続けて含むときだけ当たる。
 * 表示名で続けて当たる候補、表示名でとびとびに当たる候補、フルパスだけで当たる候補の順に並べる。
 * 返すのは元の添字。
 */
export function filterIndexes(items: readonly {name: string; path?: string}[], query: string): number[] {
  const q = query.toLowerCase();
  if (q === '') return items.map((_, i) => i);
  const scored: {i: number; score: number}[] = [];
  items.forEach((it, i) => {
    const name = it.name.toLowerCase();
    let score: number | undefined;
    if (name.includes(q)) score = 0;
    else if (subsequence(q, name)) score = 1;
    else if (it.path?.toLowerCase().includes(q)) score = 2;
    if (score !== undefined) scored.push({i, score});
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map(x => x.i);
}

/** `~` を家のディレクトリに置き換える。 */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  return p;
}

export function tildify(p: string, home: string): string {
  if (home && (p === home || p.startsWith(home + sep))) return `~${p.slice(home.length)}`;
  return p;
}
