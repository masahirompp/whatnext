// Pure logic: parse --json rows, decide tiers, estimate waiting time, derive
// wait-for relations and group the list. No I/O here.

export type RawRow = {
  kind?: string;
  sessionId?: string;
  id?: string;
  cwd?: string;
  name?: string;
  startedAt?: number;
  pid?: number;
  state?: string;
  status?: string;
  waitingFor?: string;
};

export const TIERS = ['Permission', 'Question', 'Sandbox', 'Failed', 'Review', 'Working', 'Waiting'] as const;
export type Tier = (typeof TIERS)[number];

export type Session = {
  sid: string;
  id?: string;
  kind: 'background' | 'interactive';
  cwd: string;
  name: string;
  pid?: number;
  state?: string;
  status?: string;
  waitingFor?: string;
  baseTier: Tier;
  reason?: string;
};

export function parseAgentsJson(text: string): RawRow[] {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('claude agents --json did not return an array');
  return data as RawRow[];
}

/** Returns null when the row is out of scope (stopped, interactive idle). */
export function classify(row: RawRow): { tier: Tier; reason?: string } | null {
  const wf = row.waitingFor;
  if (wf) {
    if (wf === 'permission prompt') return { tier: 'Permission' };
    if (wf === 'input needed') return { tier: 'Question' };
    if (wf === 'sandbox request') return { tier: 'Sandbox' };
    return { tier: 'Question', reason: wf };
  }
  if (row.kind === 'interactive') {
    if (row.status === 'busy') return { tier: 'Working' };
    if (row.status === 'idle') return null;
    return { tier: 'Question', reason: row.status ?? 'unknown' };
  }
  const state = row.state;
  if (state === 'stopped') return null;
  if (state === 'failed') return { tier: 'Failed' };
  if (state === 'blocked' && row.pid == null) return { tier: 'Failed', reason: 'no process' };
  if (row.status === 'busy' || state === 'working') return { tier: 'Working' };
  if (state === 'done') return { tier: 'Review' };
  const raw = [state, row.status].filter(Boolean).join(', ');
  return { tier: 'Question', reason: raw || 'unknown' };
}

/** Collapse duplicate sessionIds: prefer the row with a pid, then background. */
export function dedupe(rows: RawRow[]): RawRow[] {
  const by = new Map<string, RawRow>();
  for (const r of rows) {
    const sid = r.sessionId ?? r.id;
    if (!sid) continue;
    const cur = by.get(sid);
    if (!cur || rank(r) > rank(cur)) by.set(sid, r);
  }
  return [...by.values()];
  function rank(r: RawRow) {
    return (r.pid != null ? 2 : 0) + (r.kind === 'background' ? 1 : 0);
  }
}

export function toSessions(rows: RawRow[]): { visible: Session[]; all: Set<string> } {
  const deduped = dedupe(rows);
  const all = new Set<string>();
  const visible: Session[] = [];
  for (const r of deduped) {
    const sid = (r.sessionId ?? r.id)!;
    all.add(sid);
    const c = classify(r);
    if (!c) continue;
    visible.push({
      sid,
      id: r.kind === 'background' ? r.id : undefined,
      kind: r.kind === 'interactive' ? 'interactive' : 'background',
      cwd: r.cwd ?? '',
      name: r.name || r.id || sid.slice(0, 8),
      pid: r.pid,
      state: r.state,
      status: r.status,
      waitingFor: r.waitingFor,
      baseTier: c.tier,
      reason: c.reason,
    });
  }
  return { visible, all };
}

export function tierLabel(s: { tier: Tier; reason?: string }) {
  return s.reason ? `${s.tier} (${s.reason})` : s.tier;
}

// ---- wait-for relations ----

export type Waits = Map<string, Set<string>>; // waiter sid -> target sids

export function reachable(waits: Waits, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const t of waits.get(cur) ?? []) stack.push(t);
  }
  return false;
}

/** Adding waiter -> target would close a loop (or is self). */
export function wouldCycle(waits: Waits, waiter: string, target: string) {
  return waiter === target || reachable(waits, target, waiter);
}

/** Drop relations whose ends vanished from --json entirely. */
export function pruneWaits(waits: Waits, all: Set<string>) {
  for (const [w, ts] of [...waits]) {
    if (!all.has(w)) {
      waits.delete(w);
      continue;
    }
    for (const t of [...ts]) if (!all.has(t)) ts.delete(t);
    if (ts.size === 0) waits.delete(w);
  }
}

/**
 * Effective tier: a waiter whose own row is Review and which has an unfinished
 * target goes to Waiting. A target is finished when it is in Review or not
 * visible at all.
 */
export function effectiveTiers(visible: Session[], waits: Waits): Map<string, Tier> {
  const bySid = new Map(visible.map((s) => [s.sid, s]));
  const memo = new Map<string, Tier>();
  const eff = (sid: string, depth = 0): Tier | undefined => {
    const s = bySid.get(sid);
    if (!s) return undefined;
    if (memo.has(sid)) return memo.get(sid);
    let t = s.baseTier;
    if (t === 'Review' && depth < 50) {
      for (const target of waits.get(sid) ?? []) {
        if (!isFinished(eff(target, depth + 1))) {
          t = 'Waiting';
          break;
        }
      }
    }
    memo.set(sid, t);
    return t;
  };
  for (const s of visible) eff(s.sid);
  return memo;
}

export function isFinished(t: Tier | undefined) {
  return t === undefined || t === 'Review';
}

export function unfinishedTargets(sid: string, waits: Waits, tiers: Map<string, Tier>): string[] {
  return [...(waits.get(sid) ?? [])].filter((t) => !isFinished(tiers.get(t)));
}

/**
 * Sessions to delete along with `root`: everything below it in the wait-for
 * graph, minus sessions also waited on by someone outside the deleted set.
 */
export function cascadeTargets(waits: Waits, root: string): string[] {
  const set = new Set<string>();
  const stack = [...(waits.get(root) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === root || set.has(cur)) continue;
    set.add(cur);
    for (const t of waits.get(cur) ?? []) stack.push(t);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of [...set]) {
      for (const [w, ts] of waits) {
        if (ts.has(t) && w !== root && !set.has(w)) {
          set.delete(t);
          changed = true;
          break;
        }
      }
    }
  }
  return [...set];
}

// ---- waiting time ----

export type Tracked = { tier: Tier; since: number | null };

/**
 * Pessimistic waiting time. First sighting at the first refresh is unknown
 * (null). Any later change of tier (or a new row) counts from the previous
 * refresh. OTel's last event, when present, tightens it for non-Working tiers.
 */
export function trackSince(
  prev: Map<string, Tracked>,
  tiers: Map<string, Tier>,
  prevRefreshAt: number | undefined,
  otelLast: (sid: string) => number | undefined,
): Map<string, Tracked> {
  const next = new Map<string, Tracked>();
  for (const [sid, tier] of tiers) {
    const p = prev.get(sid);
    let since: number | null;
    if (p && p.tier === tier) since = p.since;
    else since = prevRefreshAt ?? null;
    const o = tier === 'Working' ? undefined : otelLast(sid);
    if (o !== undefined) since = since == null ? o : Math.max(since, o);
    next.set(sid, { tier, since });
  }
  return next;
}

type Sortable = { sid: string; tier: Tier; since: number | null; name: string };

export function compareRows(a: Sortable, b: Sortable) {
  const ta = TIERS.indexOf(a.tier);
  const tb = TIERS.indexOf(b.tier);
  if (ta !== tb) return ta - tb;
  if (a.since == null && b.since != null) return -1;
  if (b.since == null && a.since != null) return 1;
  if (a.since != null && b.since != null && a.since !== b.since) return a.since - b.since;
  return a.name.localeCompare(b.name);
}

export function sortSessions<T extends Sortable>(xs: T[]): T[] {
  return [...xs].sort(compareRows);
}

export function formatWaiting(since: number | null, now: number) {
  if (since == null) return '?';
  const m = Math.floor((now - since) / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

// ---- grouping ----

export type Row = Session & { tier: Tier; since: number | null; depth?: number };
/** Rows flattened in display order; each tree is a waiter with its targets nested below. */
export type Groups = { last: Row[]; ladder: Row[]; hold: Row[]; ladderTop?: string };

/** The waiter of each visible target (a target has at most one waiter). */
export function parentsOf(rows: { sid: string }[], waits: Waits): Map<string, string> {
  const vis = new Set(rows.map((r) => r.sid));
  const parent = new Map<string, string>();
  for (const [w, ts] of waits) {
    if (!vis.has(w)) continue;
    for (const t of ts) if (vis.has(t) && !parent.has(t) && t !== w) parent.set(t, w);
  }
  return parent;
}

/**
 * Trees move along the ladder as a unit, placed by their best member. A held
 * member inside a tree stays in place but does not count for placement; a held
 * root sends the whole tree to the hold group. The tree holding the last
 * attached session goes on top.
 */
export function group(rows: Row[], lastAttached: string | undefined, holds: Map<string, string>, waits: Waits = new Map()): Groups {
  const parent = parentsOf(rows, waits);
  const children = new Map<string, Row[]>();
  for (const r of rows) {
    const p = parent.get(r.sid);
    if (p) children.set(p, [...(children.get(p) ?? []), r]);
  }
  for (const [k, v] of children) children.set(k, sortSessions(v));
  type Tree = { root: Row; flat: Row[]; best: Row };
  const trees: Tree[] = rows
    .filter((r) => !parent.has(r.sid))
    .map((root) => {
      const flat: Row[] = [];
      const walk = (r: Row, depth: number) => {
        flat.push({ ...r, depth });
        for (const c of children.get(r.sid) ?? []) walk(c, depth + 1);
      };
      walk(root, 0);
      const counted = flat.filter((r) => r.depth === 0 || !holds.has(r.sid));
      return { root, flat, best: sortSessions(counted)[0] };
    })
    .sort((a, b) => compareRows(a.best, b.best));
  const held = (t: Tree) => holds.has(t.root.sid);
  const lastTree = trees.find((t) => !held(t) && t.flat.some((r) => r.sid === lastAttached));
  const ladderTrees = trees.filter((t) => !held(t) && t !== lastTree);
  return {
    last: lastTree?.flat ?? [],
    ladder: ladderTrees.flatMap((t) => t.flat),
    hold: trees.filter(held).flatMap((t) => t.flat),
    ladderTop: ladderTrees[0]?.best.sid,
  };
}

export function flatOrder(g: Groups): Row[] {
  return [...g.last, ...g.ladder, ...g.hold];
}

/** Someone other than `waiter` already waits for `target`. */
export function waitedByOther(waits: Waits, waiter: string, target: string) {
  for (const [w, ts] of waits) if (w !== waiter && ts.has(target)) return true;
  return false;
}
