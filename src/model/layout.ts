import type {Group, Inputs, Layout, Node, Row, Tier, Times} from './types.js';
import {deriveTiers, stageStarts, validWaits} from './waits.js';

/** 見出しと名前の順(人の読み方の順。PRODUCT.md「リポジトリの区切りと並び」)。 */
export const byReading = (a: string, b: string): number => {
  const c = a.localeCompare(b, undefined, {sensitivity: 'base'});
  if (c !== 0) return c;
  return a < b ? -1 : a > b ? 1 : 0;
};

/** 区切りの見出し。同じ名前が2つ以上あるときだけ、区別できるところまで親のディレクトリ名を足す。 */
export function groupTitles(roots: readonly string[]): Map<string, string> {
  const parts = new Map(roots.map(r => [r, r.split('/').filter(Boolean)]));
  const depth = new Map(roots.map(r => [r, 1]));
  const title = (r: string) => {
    const p = parts.get(r) ?? [];
    const d = Math.min(depth.get(r) ?? 1, p.length);
    return d === 0 ? r : p.slice(p.length - d).join('/');
  };
  for (let round = 0; round < 64; round++) {
    const byTitle = new Map<string, string[]>();
    for (const r of roots) {
      const t = title(r);
      byTitle.set(t, [...(byTitle.get(t) ?? []), r]);
    }
    let changed = false;
    for (const rs of byTitle.values()) {
      if (rs.length < 2) continue;
      for (const r of rs) {
        const p = parts.get(r) ?? [];
        const d = depth.get(r) ?? 1;
        if (d < p.length) {
          depth.set(r, d + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return new Map(roots.map(r => [r, title(r)]));
}

const touchOf = (t: Times | undefined): number => t?.attached ?? t?.first ?? 0;

/**
 * 一覧の並びを導く。リポジトリの区切りにまとめ、区切りの中は組(根を持つ木)を触った時刻の新しい順に並べる。
 * 組の位置は、根の時刻(attach した時刻、なければ初めて見た時刻)と、組の中の行に attach した時刻のうち最も新しいもの。
 */
export function layout(inp: Inputs): Layout {
  const all = new Map(inp.rows.map(r => [r.sid, r]));
  const spawned = new Set(inp.spawner.keys());
  const waits = validWaits(inp.waits, all, spawned);
  const derivedTier = deriveTiers(all, waits);
  const visible = new Map<string, Row>();
  for (const r of inp.rows) if (r.tier !== null) visible.set(r.sid, r);

  const parent = new Map<string, string>();
  for (const [w, ts] of waits) {
    if (!visible.has(w)) continue;
    for (const t of ts) if (visible.has(t)) parent.set(t, w);
  }
  for (const [s, p] of inp.spawner) {
    if (!visible.has(s) || !visible.has(p) || parent.has(s)) continue;
    parent.set(s, p);
  }
  // 念のため、親をたどって一周するものは外す(待ち先と起動元が重なった場合など)。
  for (const s of [...parent.keys()]) {
    const seen = new Set<string>([s]);
    let cur = parent.get(s);
    while (cur !== undefined) {
      if (seen.has(cur)) {
        parent.delete(s);
        break;
      }
      seen.add(cur);
      cur = parent.get(cur);
    }
  }

  const children = new Map<string, string[]>();
  for (const [c, p] of parent) children.set(p, [...(children.get(p) ?? []), c]);
  const nameOf = (sid: string) => visible.get(sid)?.name ?? sid;
  const bySiblingOrder = (a: string, b: string) =>
    touchOf(inp.times.get(b)) - touchOf(inp.times.get(a)) || byReading(nameOf(a), nameOf(b)) || byReading(a, b);
  for (const cs of children.values()) cs.sort(bySiblingOrder);

  const attachedIn = (sid: string): number => {
    let m = inp.times.get(sid)?.attached ?? 0;
    for (const c of children.get(sid) ?? []) m = Math.max(m, attachedIn(c));
    return m;
  };
  const roots = [...visible.keys()].filter(s => !parent.has(s));
  const treeKey = new Map(roots.map(r => [r, Math.max(touchOf(inp.times.get(r)), attachedIn(r))]));

  const groupRoots = [...new Set(roots.map(r => visible.get(r)?.group ?? ''))];
  const titles = groupTitles(groupRoots);
  const groups: Group[] = groupRoots
    .map(root => ({root, title: titles.get(root) ?? root, nodes: [] as Node[]}))
    .sort((a, b) => byReading(a.title, b.title) || byReading(a.root, b.root));

  const tier = new Map<string, Tier>();
  for (const sid of visible.keys()) {
    const t = derivedTier.get(sid);
    if (t) tier.set(sid, t);
  }
  const order: string[] = [];
  for (const g of groups) {
    const rs = roots
      .filter(r => visible.get(r)?.group === g.root)
      .sort(
        (a, b) => (treeKey.get(b) ?? 0) - (treeKey.get(a) ?? 0) || byReading(nameOf(a), nameOf(b)) || byReading(a, b),
      );
    const walk = (sid: string, depth: number, last: boolean, ancestorsLast: boolean[]) => {
      const cs = children.get(sid) ?? [];
      g.nodes.push({sid, depth, last, ancestorsLast, hasChildren: cs.length > 0, spawned: spawned.has(sid)});
      order.push(sid);
      cs.forEach((c, i) => {
        walk(c, depth + 1, i === cs.length - 1, depth === 0 ? [] : [...ancestorsLast, last]);
      });
    };
    for (const r of rs) walk(r, 0, true, []);
  }
  return {groups, order, parent, tier};
}

/** 各行の今の段に入った時刻。待ちが明けた待ち元は、待ちが明けた時刻にする(`stageStarts`)。 */
export function stageStartsOf(
  inp: Inputs,
  own: ReadonlyMap<string, number | undefined>,
  leftWait: ReadonlyMap<string, number | undefined>,
): Map<string, number | undefined> {
  const all = new Map(inp.rows.map(r => [r.sid, r]));
  const waits = validWaits(inp.waits, all, new Set(inp.spawner.keys()));
  return stageStarts(waits, deriveTiers(all, waits), own, leftWait);
}
