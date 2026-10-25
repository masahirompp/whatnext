import type {Inputs, Layout} from './types.js';
import {validWaits} from './waits.js';

export interface WaitCandidate {
  sid: string;
  /** すでにこの待ち元の待ち先か(選ぶと外れる)。 */
  linked: boolean;
}

/**
 * `f` のメニューに並べる既存のセッション(一覧と同じ順)。待ち元自身、起動された行、
 * 選ぶと一周するセッション(待ち元の祖先)、ほかの待ち元の待ち先は並べない。
 */
export function waitCandidates(inp: Inputs, l: Layout, waiter: string): WaitCandidate[] {
  const all = new Map(inp.rows.map(r => [r.sid, r]));
  const spawned = new Set(inp.spawner.keys());
  const waits = validWaits(inp.waits, all, spawned);
  const waitParent = new Map<string, string>();
  for (const [w, ts] of waits) for (const t of ts) waitParent.set(t, w);
  const ancestors = new Set<string>();
  for (let cur = waitParent.get(waiter); cur !== undefined && !ancestors.has(cur); cur = waitParent.get(cur)) {
    ancestors.add(cur);
  }
  const mine = new Set(waits.get(waiter) ?? []);
  const out: WaitCandidate[] = [];
  for (const sid of l.order) {
    if (sid === waiter || spawned.has(sid) || ancestors.has(sid)) continue;
    const p = waitParent.get(sid);
    if (p !== undefined && p !== waiter) continue;
    out.push({sid, linked: mine.has(sid)});
  }
  return out;
}

/** 結ぶと木でなくなるか(一周する、ほかの待ち元の待ち先、起動された行)。 */
export function canLink(inp: Inputs, waiter: string, target: string): boolean {
  if (waiter === target) return false;
  const all = new Map(inp.rows.map(r => [r.sid, r]));
  const spawned = new Set(inp.spawner.keys());
  if (spawned.has(waiter) || spawned.has(target)) return false;
  if (all.get(waiter)?.kind !== 'background') return false;
  const waits = validWaits(inp.waits, all, spawned);
  const waitParent = new Map<string, string>();
  for (const [w, ts] of waits) for (const t of ts) waitParent.set(t, w);
  const p = waitParent.get(target);
  if (p !== undefined && p !== waiter) return false;
  for (let cur: string | undefined = waiter, n = 0; cur !== undefined && n < 10000; cur = waitParent.get(cur), n++) {
    if (cur === target) return false;
  }
  return true;
}

/**
 * 削除するときに巻き込む候補(待ち先と、待ち先の待ち先)。`background` の行だけを、木の上から順に返す。
 * 対話セッションと起動された行は消せないので並べないが、その下に消せる待ち先がいれば並べる。
 */
export function cascade(inp: Inputs, root: string): string[] {
  const all = new Map(inp.rows.map(r => [r.sid, r]));
  const waits = validWaits(inp.waits, all, new Set(inp.spawner.keys()));
  const out: string[] = [];
  const seen = new Set<string>([root]);
  const walk = (sid: string) => {
    for (const t of waits.get(sid) ?? []) {
      if (seen.has(t) || !all.has(t)) continue;
      seen.add(t);
      if (all.get(t)?.kind === 'background') out.push(t);
      walk(t);
    }
  };
  walk(root);
  return out;
}
