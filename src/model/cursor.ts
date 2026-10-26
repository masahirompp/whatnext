import type {Layout, Times} from './types.js';

const spawnedOf = (l: Layout) => new Set(l.groups.flatMap(g => g.nodes.filter(n => n.spawned).map(n => n.sid)));

/** カーソルで選べる行の並び。起動された行は選べない(PRODUCT.md「起動された行」)。 */
export function selectableOrder(l: Layout): string[] {
  const spawned = spawnedOf(l);
  return l.order.filter(s => !spawned.has(s));
}

/** 起動したときの行。最も新しく attach したセッション。なければ選べる最初の行。 */
export function initialCursor(l: Layout, times: ReadonlyMap<string, Times>): string | undefined {
  const order = selectableOrder(l);
  let best: string | undefined;
  let at = -1;
  for (const sid of order) {
    const a = times.get(sid)?.attached;
    if (a !== undefined && a > at) {
      best = sid;
      at = a;
    }
  }
  return best ?? order[0];
}

/**
 * 更新のあとの行(PRODUCT.md「リポジトリの区切りと並び」の「カーソル」)。
 * 選んでいた行が残っていて選べればその行。
 * それ以外は、前の並びで同じ区切りの次の行、前の行、隣の区切りの行の順。起動された行は選ばない。
 */
export function followCursor(prev: Layout, sid: string | undefined, next: Layout): string | undefined {
  const selectable = new Set(selectableOrder(next));
  const ok = selectable.has.bind(selectable);
  if (sid === undefined) return next.order.find(ok);
  if (ok(sid)) return sid;
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
  return next.order.find(ok);
}
