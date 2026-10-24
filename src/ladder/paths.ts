// 段と並び: パスの表示名。`n` の作業ディレクトリの候補と、リポジトリのビューの区切りの見出しで共有する。

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
