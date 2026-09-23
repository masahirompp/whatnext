// 優先度ラダー: `claude agents --json --all` の行から段を決め、並べる。

export type AgentRow = {
  id?: string | null;
  cwd?: string | null;
  kind?: string | null;
  startedAt?: number | null;
  sessionId: string;
  name?: string | null;
  state?: string | null;
  status?: string | null;
  waitingFor?: string | null;
  pid?: number | null;
};

export type Tier = 'permission' | 'question' | 'sandbox' | 'failed' | 'review' | 'working';

export const TIER_ORDER: Tier[] = ['permission', 'question', 'sandbox', 'failed', 'review', 'working'];

export const TIER_LABEL: Record<Tier, string> = {
  permission: 'Permission',
  question: 'Question',
  sandbox: 'Sandbox',
  failed: 'Failed',
  review: 'Review',
  working: 'Working',
};

export type Classified = { tier: Tier; reason: string } | null;

const hasPid = (row: AgentRow) => typeof row.pid === 'number';

export function classify(row: AgentRow): Classified {
  // waitingFor を最優先にする(対話セッションは state を持たない)
  switch (row.waitingFor) {
    case 'permission prompt':
      return { tier: 'permission', reason: 'permission prompt' };
    case 'input needed':
      return { tier: 'question', reason: 'input needed' };
    case 'sandbox request':
      return { tier: 'sandbox', reason: 'sandbox request' };
  }
  if (row.state === 'failed') return { tier: 'failed', reason: 'failed' };
  if (row.state === 'blocked' && !hasPid(row)) return { tier: 'failed', reason: 'blocked, no process' };
  // 未知の waitingFor は人の手を待って止まっているとみなし、沈めない(#3)
  if (row.waitingFor) return { tier: 'question', reason: row.waitingFor };
  if (row.state === 'blocked') return { tier: 'question', reason: 'blocked' };
  if (row.state === 'done') return { tier: 'review', reason: 'done' };
  if (row.status === 'busy' || row.state === 'working') return { tier: 'working', reason: 'running' };
  return null;
}

// 同じ sessionId が二重に出たら、id を持ち attach できる background の行を採る
export function dedupe(rows: AgentRow[]): AgentRow[] {
  const score = (r: AgentRow) => (r.kind === 'background' ? 2 : 0) + (r.id ? 1 : 0);
  const bySession = new Map<string, AgentRow>();
  for (const row of rows) {
    const prev = bySession.get(row.sessionId);
    if (!prev || score(row) > score(prev)) bySession.set(row.sessionId, row);
  }
  return [...bySession.values()];
}

export type ListItem = {
  row: AgentRow;
  tier: Tier;
  reason: string;
  // 今の段に入ったとみなす時刻。null は不明(`?`)
  since: number | null;
};

// 待機時間の観測。プロセス内のメモリだけに持つ(ADR-0002)
export class Observer {
  private seen = new Map<string, { tier: Tier; since: number | null }>();
  private lastRefreshAt: number | null = null;

  observe(rows: AgentRow[], now: number): ListItem[] {
    const next = new Map<string, { tier: Tier; since: number | null }>();
    const items: ListItem[] = [];
    for (const row of dedupe(rows)) {
      const c = classify(row);
      if (!c) continue;
      const prev = this.seen.get(row.sessionId);
      // 悲観的に数える: 更新の間に今の段に入った行は前回の更新時刻から待っていたとみなす
      const since = prev && prev.tier === c.tier ? prev.since : this.lastRefreshAt;
      next.set(row.sessionId, { tier: c.tier, since });
      items.push({ row, tier: c.tier, reason: c.reason, since });
    }
    this.seen = next;
    this.lastRefreshAt = now;
    return sortItems(items);
  }
}

export function sortItems(items: ListItem[]): ListItem[] {
  return [...items].sort((a, b) => {
    const t = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
    if (t !== 0) return t;
    // 不明は同じ段の先頭。それ以外は待機時間の長い順(since の古い順)
    if (a.since === null && b.since !== null) return -1;
    if (b.since === null && a.since !== null) return 1;
    if (a.since !== null && b.since !== null && a.since !== b.since) return a.since - b.since;
    return a.row.sessionId.localeCompare(b.row.sessionId);
  });
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '?';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}
