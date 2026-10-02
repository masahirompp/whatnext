// 段と並び: 待ちの段、待機時間、一言、組(Last attached、Up next、On hold、待ち先の入れ子)を決める。純粋な関数。

import {type AgentRow, classify, rowName, statusLabel, TIERS, type Tier} from './classify.js';

/** フック、会話記録、OTel から補う値。どれも今のターンのものだけを入れる。 */
export interface Supplement {
  /** 今のターンの指示(冒頭の1行)と、それを送った時刻。 */
  prompt?: {text: string; at: number};
  /** 今のターンで止まった時刻(Stop、StopFailure、PermissionRequest、AskUserQuestion、または会話記録の該当する行)。 */
  haltAt?: number;
  /** 権限を求めている道具と対象(`Bash: <コマンド>`)。 */
  permission?: string;
  /** `AskUserQuestion` の質問。 */
  question?: string;
  /** 権限の確認で断った道具と対象。 */
  declined?: string;
  /** 失敗の文言(なければ符号)。 */
  error?: string;
  /** 最後の応答の冒頭。 */
  lastText?: string;
  /** 今のコンテキストの大きさ(token)。 */
  ctx?: number;
}

/** 一言を段に合わせて選ぶ。 */
export function noteFor(tier: Tier, sup: Supplement | undefined): string | undefined {
  if (!sup) return undefined;
  switch (tier) {
    case 'working':
      return sup.prompt ? `→ ${sup.prompt.text}` : undefined;
    case 'permission':
    case 'sandbox':
      return sup.permission ?? sup.lastText;
    case 'question':
      return sup.question ?? (sup.declined ? `Declined: ${sup.declined}` : undefined) ?? sup.lastText;
    case 'failed':
      return sup.error ?? sup.lastText;
    default:
      return sup.lastText;
  }
}

// ---- 待機時間 ----

export interface WaitMemo {
  /** 前回の更新の時刻。まだ一度も更新していなければ null。 */
  refreshedAt: number | null;
  entries: ReadonlyMap<string, {tier: Tier; since: number | null}>;
}

export const emptyWaitMemo: WaitMemo = {refreshedAt: null, entries: new Map()};

/**
 * 更新のたびに、各行が今の段に入った時刻を決め直す。
 * フックか会話記録の時刻があればそれを使い、なければ観測から悲観的に推定する。
 */
export function trackWaits(
  prev: WaitMemo,
  tiers: ReadonlyMap<string, Tier>,
  sups: ReadonlyMap<string, Supplement>,
  now: number,
): WaitMemo {
  const entries = new Map<string, {tier: Tier; since: number | null}>();
  for (const [sid, tier] of tiers) {
    const sup = sups.get(sid);
    let hint: number | undefined;
    if (tier === 'working') hint = sup?.prompt?.at;
    else if (tier !== 'stopped' && tier !== 'waiting') hint = sup?.haltAt;
    const before = prev.entries.get(sid);
    let since: number | null;
    if (hint !== undefined) since = Math.min(hint, now);
    else if (before && before.tier === tier) since = before.since;
    else since = prev.refreshedAt;
    entries.set(sid, {tier, since});
  }
  return {refreshedAt: now, entries};
}

// ---- 組 ----

/** `↳ <名前> done` を出すかを決めるための、前回までの観測。 */
export interface DoneMemo {
  /** 前回の並べ替えで待ちの段にいた待ち元。 */
  waiting: ReadonlySet<string>;
  /** `↳ done` を出している待ち元。 */
  done: ReadonlySet<string>;
}

export const emptyDoneMemo: DoneMemo = {waiting: new Set(), done: new Set()};

export interface ArrangeInput {
  rows: readonly AgentRow[];
  holds: ReadonlyMap<string, string>;
  waits: ReadonlyMap<string, readonly string[]>;
  lastAttached: string | null;
  waitSince: ReadonlyMap<string, number | null>;
  sups: ReadonlyMap<string, Supplement>;
  doneMemo: DoneMemo;
}

export interface Entry {
  sid: string;
  row: AgentRow;
  name: string;
  tier: Tier;
  /** STATUS の列の文字。 */
  status: string;
  since: number | null;
  note?: string;
  ctx?: number;
  /** 入れ子の深さ(根は0)。 */
  depth: number;
  /** 祖先から自分までの各段で、その行が兄弟の最後かどうか(根を除く)。線を引くのに使う。 */
  lastChain: boolean[];
  /** 組の途中で保留にした行。 */
  midHold: boolean;
  holdReason?: string;
  /** 待ち先がすべて終わったときに出す名前。 */
  doneNames?: string[];
}

export interface Group {
  rootSid: string;
  entries: Entry[];
  /** 組の位置を決めた行(実際に手を付ける行)。 */
  positionSid: string;
}

export interface Arranged {
  lastAttached: Group | null;
  upNext: Group[];
  onHold: Group[];
  doneMemo: DoneMemo;
  /** 段の判定(対象外の行は含まない)。待ちの段を導いたあとの値。 */
  tiers: Map<string, Tier>;
}

/** 行の段を、待ち先の関係から待ちの段を導いたうえで決める。 */
export function effectiveTiers(
  rows: readonly AgentRow[],
  waits: ReadonlyMap<string, readonly string[]>,
): {tiers: Map<string, Tier>; reasons: Map<string, string>} {
  const raw = new Map<string, Tier>();
  const reasons = new Map<string, string>();
  for (const row of rows) {
    const c = classify(row);
    if (c.tier === null) continue;
    raw.set(row.sessionId, c.tier);
    if (c.reason) reasons.set(row.sessionId, c.reason);
  }
  const tiers = new Map<string, Tier>();
  const visiting = new Set<string>();
  const resolve = (sid: string): Tier | undefined => {
    const own = raw.get(sid);
    if (own === undefined) return undefined;
    const done = tiers.get(sid);
    if (done) return done;
    let tier = own;
    if (own === 'review' && !visiting.has(sid)) {
      visiting.add(sid);
      const pending = (waits.get(sid) ?? []).some(t => {
        const tt = resolve(t);
        return tt !== undefined && tt !== 'review' && tt !== 'stopped';
      });
      visiting.delete(sid);
      if (pending) tier = 'waiting';
    }
    tiers.set(sid, tier);
    return tier;
  };
  for (const sid of raw.keys()) resolve(sid);
  return {tiers, reasons};
}

function rankKey(tier: Tier, since: number | null, name: string): [number, number, number, string] {
  return [TIERS.indexOf(tier), since === null ? 0 : 1, since ?? 0, name];
}

function compareKeys(a: [number, number, number, string], b: [number, number, number, string]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0;
}

/** 一覧を組に分けて並べる。 */
export function arrange(input: ArrangeInput): Arranged {
  const {rows, holds, waits, lastAttached, waitSince, sups} = input;
  const {tiers, reasons} = effectiveTiers(rows, waits);
  const rowBySid = new Map(rows.map(r => [r.sessionId, r]));
  const visible = (sid: string) => tiers.has(sid);

  // `↳ done` の更新
  const nowWaiting = new Set<string>();
  const done = new Set<string>();
  for (const [sid, targets] of waits) {
    if (!visible(sid) || targets.length === 0) continue;
    if (tiers.get(sid) === 'waiting') {
      nowWaiting.add(sid);
      continue;
    }
    const allDone = targets.every(t => {
      const tt = tiers.get(t);
      return tt === undefined || tt === 'review' || tt === 'stopped';
    });
    if (allDone && (input.doneMemo.done.has(sid) || input.doneMemo.waiting.has(sid))) done.add(sid);
  }
  const doneMemo: DoneMemo = {waiting: nowWaiting, done};

  // 待ち元(見えているもの)
  const waiterOf = new Map<string, string>();
  for (const [waiter, targets] of waits) {
    if (!visible(waiter)) continue;
    for (const t of targets) if (visible(t)) waiterOf.set(t, waiter);
  }

  const keyOf = (sid: string) => {
    const row = rowBySid.get(sid) as AgentRow;
    return rankKey(tiers.get(sid) as Tier, waitSince.get(sid) ?? null, rowName(row));
  };

  const childrenOf = (sid: string): string[] =>
    (waits.get(sid) ?? [])
      .filter(t => visible(t) && waiterOf.get(t) === sid)
      .sort((a, b) => compareKeys(keyOf(a), keyOf(b)));

  const buildGroup = (root: string): Group => {
    const entries: Entry[] = [];
    let position = root;
    let positionKey: ReturnType<typeof keyOf> | null = null;
    const rootHeld = holds.has(root);
    const walk = (sid: string, depth: number, lastChain: boolean[]) => {
      const row = rowBySid.get(sid) as AgentRow;
      const tier = tiers.get(sid) as Tier;
      const midHold = depth > 0 && holds.has(sid);
      const sup = sups.get(sid);
      const targets = (waits.get(sid) ?? []).filter(t => rowBySid.has(t));
      const entry: Entry = {
        sid,
        row,
        name: rowName(row),
        tier,
        status: statusLabel(tier, reasons.get(sid)),
        since: waitSince.get(sid) ?? null,
        note: noteFor(tier, sup),
        ctx: sup?.ctx,
        depth,
        lastChain,
        midHold,
        holdReason: holds.get(sid) || undefined,
      };
      if (done.has(sid) && targets.length > 0) entry.doneNames = targets.map(t => rowName(rowBySid.get(t) as AgentRow));
      entries.push(entry);
      if (!midHold || rootHeld) {
        const k = keyOf(sid);
        if (positionKey === null || compareKeys(k, positionKey) < 0) {
          positionKey = k;
          position = sid;
        }
      }
      const kids = childrenOf(sid);
      kids.forEach((kid, i) => {
        walk(kid, depth + 1, [...lastChain, i === kids.length - 1]);
      });
    };
    walk(root, 0, []);
    return {rootSid: root, entries, positionSid: position};
  };

  const roots = rows.map(r => r.sessionId).filter(sid => visible(sid) && !waiterOf.has(sid));
  const groups = roots.map(buildGroup);
  const groupKey = (g: Group) => keyOf(g.positionSid);
  groups.sort((a, b) => compareKeys(groupKey(a), groupKey(b)));

  let lastGroup: Group | null = null;
  const upNext: Group[] = [];
  const onHold: Group[] = [];
  for (const g of groups) {
    if (holds.has(g.rootSid)) onHold.push(g);
    else if (lastAttached !== null && lastGroup === null && g.entries.some(e => e.sid === lastAttached)) lastGroup = g;
    else upNext.push(g);
  }
  return {lastAttached: lastGroup, upNext, onHold, doneMemo, tiers};
}

/** 組を上から順に並べた行の一覧。 */
export function flatten(a: Arranged): Entry[] {
  const out: Entry[] = [];
  if (a.lastAttached) out.push(...a.lastAttached.entries);
  for (const g of a.upNext) out.push(...g.entries);
  for (const g of a.onHold) out.push(...g.entries);
  return out;
}

/** `sid` を含む組の行(待ち先の待ち先を含む)。 */
export function subtreeOf(a: Arranged, sid: string): string[] {
  const all = [a.lastAttached, ...a.upNext, ...a.onHold].filter((g): g is Group => g !== null);
  for (const g of all) {
    const i = g.entries.findIndex(e => e.sid === sid);
    if (i < 0) continue;
    const depth = g.entries[i]?.depth ?? 0;
    const out = [sid];
    for (let j = i + 1; j < g.entries.length; j++) {
      const e = g.entries[j] as Entry;
      if (e.depth <= depth) break;
      out.push(e.sid);
    }
    return out;
  }
  return [sid];
}
