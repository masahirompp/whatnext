// Priority ladder: classify `claude agents --json --all` rows into tiers and order them.

export type AgentRow = {
  id?: string;
  sessionId: string;
  kind: string;
  cwd: string;
  name?: string;
  startedAt?: number;
  state?: string | null;
  status?: string | null;
  waitingFor?: string | null;
  pid?: number | null;
};

export const TIERS = ['Permission', 'Question', 'Sandbox', 'Failed', 'Review', 'Working'] as const;
export type Tier = (typeof TIERS)[number];

export type Classified = { row: AgentRow; tier: Tier; reason?: string };

const hasPid = (r: AgentRow) => r.pid !== undefined && r.pid !== null;

// Same sessionId may appear twice (background + interactive). Prefer the one with a live pid,
// otherwise the background row.
export function dedupe(rows: AgentRow[]): AgentRow[] {
  const by = new Map<string, AgentRow>();
  for (const r of rows) {
    const cur = by.get(r.sessionId);
    if (!cur) { by.set(r.sessionId, r); continue; }
    const score = (x: AgentRow) => (hasPid(x) ? 2 : 0) + (x.kind === 'background' ? 1 : 0);
    if (score(r) > score(cur)) by.set(r.sessionId, r);
  }
  return [...by.values()];
}

export function classify(r: AgentRow): Classified | null {
  const w = r.waitingFor;
  if (w) {
    if (w === 'permission prompt') return { row: r, tier: 'Permission' };
    if (w === 'input needed') return { row: r, tier: 'Question' };
    if (w === 'sandbox request') return { row: r, tier: 'Sandbox' };
    return { row: r, tier: 'Question', reason: w };
  }
  const status = r.status ?? null;
  if (r.kind === 'interactive') {
    if (status === 'idle') return null;
    if (status === 'busy') return { row: r, tier: 'Working' };
    return { row: r, tier: 'Question', reason: status ?? 'unknown' };
  }
  const state = r.state ?? null;
  if (state === 'failed') return { row: r, tier: 'Failed' };
  if (status === 'busy' || state === 'working') return { row: r, tier: 'Working' };
  if (state === 'done') return { row: r, tier: 'Review' };
  if (state === 'blocked') {
    if (!hasPid(r)) return { row: r, tier: 'Failed', reason: 'no process' };
    return { row: r, tier: 'Question', reason: 'blocked' };
  }
  if (state === 'stopped') return null;
  if (status === 'waiting') return { row: r, tier: 'Question', reason: 'waiting' };
  return { row: r, tier: 'Question', reason: state ?? status ?? 'unknown' };
}

export function tierLabel(c: { tier: Tier; reason?: string }): string {
  return c.reason ? `${c.tier} (${c.reason})` : c.tier;
}

// Observation of when each session entered its current tier. Kept only in memory (ADR-0002).
export type Seen = Map<string, { key: string; since: number | null }>;

export type Entry = Classified & { since: number | null };

// Apply one refresh. `prevRefresh` is the time of the previous refresh (null on the first one).
// New arrivals in a tier are pessimistically assumed to have waited since the previous refresh.
// `lastEvent` (OTel trial, #58): a waiting row's last event time is taken as when it stopped.
export function observe(
  rows: AgentRow[],
  seen: Seen,
  prevRefresh: number | null,
  lastEvent: Map<string, number> = new Map(),
): { entries: Entry[]; seen: Seen } {
  const next: Seen = new Map();
  const entries: Entry[] = [];
  for (const r of dedupe(rows)) {
    const c = classify(r);
    if (!c) continue;
    const key = c.tier;
    const old = seen.get(r.sessionId);
    const ev = c.tier === 'Working' ? undefined : lastEvent.get(r.sessionId);
    const since = ev ?? (old && old.key === key ? old.since : prevRefresh);
    next.set(r.sessionId, { key, since });
    entries.push({ ...c, since });
  }
  return { entries: sortEntries(entries), seen: next };
}

// Tier order, then unknown wait (`?`) first, then longest wait first.
export function sortEntries(entries: Entry[]): Entry[] {
  const rank = (e: Entry) => TIERS.indexOf(e.tier);
  return [...entries].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.since === null && b.since !== null) return -1;
    if (b.since === null && a.since !== null) return 1;
    if (a.since !== null && b.since !== null && a.since !== b.since) return a.since - b.since;
    return a.row.sessionId.localeCompare(b.row.sessionId);
  });
}

export function formatWait(since: number | null, now: number): string {
  if (since === null) return '?';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  // Minutes are the smallest unit: a per-second counter flickers and the order only cares about minutes.
  if (s < 60) return '<1m';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

// The session last left by attach is shown as its own group above the ladder, until the next
// attach. It stays out of the ladder so it is not listed twice. `id` is the agent id.
export function splitLast(entries: Entry[], id: string | null): { last: Entry | null; rest: Entry[] } {
  const last = id ? entries.find((e) => e.row.id === id) ?? null : null;
  return { last, rest: last ? entries.filter((e) => e !== last) : entries };
}
