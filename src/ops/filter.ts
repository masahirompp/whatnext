// 候補の絞り込み(PRODUCT.md「操作」の `n`)。表示名は入力の文字が順に含まれていれば当たり、
// フルパスは入力がそのまま続けて含まれるときだけ当たる。表示名で当たった候補を上に、続けて一致する候補をさらに上に置く。

export interface Filterable {
  label: string;
  path?: string;
}

function subsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (i < needle.length && ch === needle[i]) i++;
  }
  return i === needle.length;
}

export function filterItems<T extends Filterable>(items: readonly T[], input: string): T[] {
  const q = input.toLowerCase();
  if (!q) return [...items];
  const ranked: {item: T; rank: number; idx: number}[] = [];
  items.forEach((item, idx) => {
    const label = item.label.toLowerCase();
    let rank = -1;
    if (label.includes(q)) rank = 0;
    else if (subsequence(label, q)) rank = 1;
    else if (item.path?.toLowerCase().includes(q)) rank = 2;
    if (rank >= 0) ranked.push({item, rank, idx});
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.idx - b.idx).map(r => r.item);
}
