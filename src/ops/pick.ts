// 操作: 候補の表示名と絞り込み(`n` の作業ディレクトリと `f` のメニュー)。

import {sep} from 'node:path';

export {displayNames} from '../ladder/paths.js';

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
