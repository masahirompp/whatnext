import type {Layout, Times} from './types.js';

const isSpawned = (l: Layout, sid: string) => l.groups.some(g => g.nodes.some(n => n.sid === sid && n.spawned));

/** 起動したときの行。最も新しく attach したセッション。なければ起動された行でない最初の行。 */
export function initialCursor(l: Layout, times: ReadonlyMap<string, Times>): string | undefined {
  let best: string | undefined;
  let at = -1;
  for (const sid of l.order) {
    const a = times.get(sid)?.attached;
    if (a !== undefined && a > at && !isSpawned(l, sid)) {
      best = sid;
      at = a;
    }
  }
  return best ?? l.order.find(s => !isSpawned(l, s)) ?? l.order[0];
}

/**
 * 更新のあとの行(PRODUCT.md「リポジトリの区切りと並び」の「カーソル」)。
 * 選んでいた行が残っていればその行。消えた起動された行なら、前の組で起動元を近い順にたどり、
 * 新しい一覧に残っていて起動された行でない最初の行(大本の起動元まで)。
 * それ以外は、前の並びで同じ区切りの次の行、前の行、隣の区切りの行の順。起動された行は選ばない。
 */
export function followCursor(prev: Layout, sid: string | undefined, next: Layout): string | undefined {
  if (sid === undefined) return next.order.find(s => !isSpawned(next, s)) ?? next.order[0];
  if (next.order.includes(sid)) return sid;
  const ok = (s: string) => next.order.includes(s) && !isSpawned(next, s);
  if (isSpawned(prev, sid)) {
    let cur = prev.parent.get(sid);
    while (cur !== undefined) {
      if (ok(cur)) return cur;
      if (!isSpawned(prev, cur)) break;
      cur = prev.parent.get(cur);
    }
  }
  const gi = prev.groups.findIndex(g => g.nodes.some(n => n.sid === sid));
  if (gi >= 0) {
    const nodes = prev.groups[gi].nodes.map(n => n.sid);
    const i = nodes.indexOf(sid);
    for (let j = i + 1; j < nodes.length; j++) if (ok(nodes[j])) return nodes[j];
    for (let j = i - 1; j >= 0; j--) if (ok(nodes[j])) return nodes[j];
    for (let d = 1; d < prev.groups.length + next.groups.length; d++) {
      const after = prev.groups[gi + d]?.nodes.map(n => n.sid).find(ok);
      if (after) return after;
      const before = prev.groups[gi - d]?.nodes
        .map(n => n.sid)
        .reverse()
        .find(ok);
      if (before) return before;
    }
  }
  return next.order.find(ok) ?? next.order[0];
}
