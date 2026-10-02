// 段と並び: `--json` の行から段を決める(PRODUCT.md「`--json` の行から段を決める規則」)。

/** `claude agents --json --all` の1行。段と並びが読む項目だけを持つ。 */
export interface AgentRow {
  kind: string;
  sessionId: string;
  id?: string;
  cwd: string;
  name?: string;
  startedAt?: number;
  pid?: number;
  state?: string;
  status?: string;
  waitingFor?: string;
}

export type Tier = 'permission' | 'question' | 'sandbox' | 'failed' | 'review' | 'working' | 'waiting' | 'stopped';

/** 優先度ラダーの順。 */
export const TIERS: readonly Tier[] = [
  'permission',
  'question',
  'sandbox',
  'failed',
  'review',
  'working',
  'waiting',
  'stopped',
];

export const TIER_LABEL: Record<Tier, string> = {
  permission: 'Permission',
  question: 'Question',
  sandbox: 'Sandbox',
  failed: 'Failed',
  review: 'Review',
  working: 'Working',
  waiting: 'Waiting',
  stopped: 'Stopped',
};

export interface Classified {
  /** null は対象外(一覧に出さない)。 */
  tier: Tier | null;
  /** 段から分からないときだけ添える待機の理由。 */
  reason?: string;
}

/** 行の段を決める。待ちの段は待ち先の関係から導くので、ここでは返さない。 */
export function classify(row: AgentRow): Classified {
  const {kind, state, status, waitingFor, pid} = row;
  if (waitingFor !== undefined) {
    if (waitingFor === 'permission prompt') return {tier: 'permission'};
    if (waitingFor === 'input needed') return {tier: 'question'};
    if (waitingFor === 'sandbox request') return {tier: 'sandbox'};
    return {tier: 'question', reason: waitingFor};
  }
  if (kind === 'interactive' || state === undefined) {
    if (status === 'busy') return {tier: 'working'};
    if (kind === 'interactive' && status === 'idle') return {tier: null};
    return {tier: 'question', reason: status ?? state ?? 'unknown'};
  }
  switch (state) {
    case 'failed':
      return {tier: 'failed'};
    case 'blocked':
      if (pid === undefined) return {tier: 'failed', reason: 'no process'};
      if (status === 'busy') return {tier: 'working'};
      return {tier: 'question', reason: 'blocked'};
    case 'done':
      return {tier: 'review'};
    case 'stopped':
      return {tier: 'stopped'};
    case 'working':
      if (status === 'idle') return {tier: 'question'};
      return {tier: 'working'};
    default:
      if (status === 'busy') return {tier: 'working'};
      return {tier: 'question', reason: state};
  }
}

/** 同じ `sessionId` の行を1行にまとめる。`pid` のある行を採り、どちらもなければ `background` を採る。 */
export function dedupe(rows: readonly AgentRow[]): AgentRow[] {
  const bySid = new Map<string, AgentRow>();
  for (const row of rows) {
    const prev = bySid.get(row.sessionId);
    if (!prev || prefer(row, prev)) bySid.set(row.sessionId, row);
  }
  return [...bySid.values()];
}

function prefer(a: AgentRow, b: AgentRow): boolean {
  const aLive = a.pid !== undefined;
  const bLive = b.pid !== undefined;
  if (aLive !== bLive) return aLive;
  if (!aLive) return a.kind === 'background' && b.kind !== 'background';
  return false;
}

/** 行の名前。`name` がなければ `id`、それもなければ `sessionId` の先頭。 */
export function rowName(row: AgentRow): string {
  return row.name || row.id || row.sessionId.slice(0, 8);
}

export function statusLabel(tier: Tier, reason?: string): string {
  return reason ? `${TIER_LABEL[tier]} (${reason})` : TIER_LABEL[tier];
}
