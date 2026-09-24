// 打った文字を順に含む候補だけを残し、よく一致するものを上に並べる。同点なら元の順を保つ
export function fuzzyFilter(candidates: string[], query: string): string[] {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return candidates;
  const scored: { c: string; score: number; i: number }[] = [];
  candidates.forEach((c, i) => {
    const score = matchScore(c.toLowerCase(), q);
    if (score !== null) scored.push({ c, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.c);
}

// 小さいほどよい。連続して一致する部分文字列を最優先し、末尾(リポジトリ名)に近いほどよい
function matchScore(s: string, q: string): number | null {
  const sub = s.lastIndexOf(q);
  if (sub >= 0) return -1_000_000 + (s.length - (sub + q.length));
  // 後ろから貪欲に合わせ、一致した文字の散らばり具合を点にする
  let si = s.length - 1;
  let first = -1;
  let last = -1;
  for (let qi = q.length - 1; qi >= 0; qi--) {
    while (si >= 0 && s[si] !== q[qi]) si--;
    if (si < 0) return null;
    if (last < 0) last = si;
    first = si;
    si--;
  }
  return last - first + (s.length - last);
}
