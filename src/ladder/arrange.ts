// 段と並び: 待ちの段、待機時間、一言、組(Last attached、Up next、On hold、待ち先の入れ子)と、
// リポジトリのビューの区切りを決める。純粋な関数。

import {type AgentRow, classify, rowName, statusLabel, TIERS, type Tier} from './classify.js';
import {displayNames} from './paths.js';

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
  /** 起動された行から起動元への表(`sessionId` どうし)。 */
  spawnedBy: ReadonlyMap<string, string>;
  lastAttached: string | null;
  waitSince: ReadonlyMap<string, number | null>;
  sups: ReadonlyMap<string, Supplement>;
  doneMemo: DoneMemo;
  /** 既定はラダーのビュー。 */
  view?: 'ladder' | 'repo';
  /** リポジトリのビューで並べる時刻(最後に attach した時刻、なければ初めて見た時刻)。 */
  touched?: ReadonlyMap<string, number>;
  /** whatnext から最後に attach した時刻。リポジトリのビューで、待ち先が組の位置を動かすのは attach したときだけにする。 */
  attachedAt?: ReadonlyMap<string, number>;
  /** リポジトリのビューの区切り(元のリポジトリの根。リポジトリでなければ `cwd`)。 */
  repoOf?: ReadonlyMap<string, string>;
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
  /** 起動元の下に入れ子で並べた、起動された行。 */
  sub: boolean;
  /** 組の途中で保留にした行。 */
  midHold: boolean;
  /** 名前に `(on hold)` を添えるか(組の途中の保留と、リポジトリのビューの保留)。 */
  holdMark: boolean;
  holdReason?: string;
  /** 待ち先がすべて終わったときに出す名前。 */
  doneNames?: string[];
}

export interface Group {
  rootSid: string;
  entries: Entry[];
  /** 組の位置を決めた行(実際に手を付ける行)。 */
  positionSid: string;
  /** リポジトリのビューで組の位置を決める時刻。 */
  at?: number;
}

/** リポジトリのビューの区切り。 */
export interface RepoSection {
  key: string;
  /** 見出し。ディレクトリ名が重なるときだけ、区別できるところまで親のディレクトリ名を足す。 */
  label: string;
  groups: Group[];
}

export interface Arranged {
  lastAttached: Group | null;
  upNext: Group[];
  onHold: Group[];
  /** リポジトリのビューのときだけ。このとき lastAttached、upNext、onHold は空。 */
  repos?: RepoSection[];
  doneMemo: DoneMemo;
  /** 段の判定(対象外の行は含まない)。待ちの段を導いたあとの値。 */
  tiers: Map<string, Tier>;
  /** 起動元の下に入れ子で並べた、起動された行。 */
  subs: Set<string>;
}

/**
 * 待ち先の関係に、起動元から起動された行への辺を足す。
 * 利用者が注釈を付けた行(自分の待ち先を持つ行、一覧に出ている待ち元に結ばれた行、保留の行)には辺を足さず、普通の行として扱う。
 * こうすると、起動された行からたどれるのは起動された行だけになり(プロセスの木)、関係は一周しない。
 * 起動された行では `f` も `h` も断るので、注釈を付けたあとに起動された行になると、その注釈を外せなくなることも防ぐ。
 * 返す `linked` は、起動元への辺を足した行。起動元が一覧に出ていなければ、実際には入れ子にならない(入れ子で並ぶ行は `Arranged.subs`)。
 */
export function linksWithSpawned(
  waits: ReadonlyMap<string, readonly string[]>,
  holds: ReadonlyMap<string, string>,
  spawnedBy: ReadonlyMap<string, string>,
  shown: ReadonlySet<string>,
): {links: Map<string, readonly string[]>; linked: Set<string>} {
  const links = new Map<string, readonly string[]>(waits);
  const linked = new Set<string>();
  const bound = new Set<string>(holds.keys());
  for (const [waiter, targets] of waits) {
    if (targets.length > 0) bound.add(waiter);
    if (shown.has(waiter)) for (const t of targets) bound.add(t);
  }
  for (const [child, parent] of spawnedBy) {
    if (bound.has(child)) continue;
    links.set(parent, [...(links.get(parent) ?? []), child]);
    linked.add(child);
  }
  return {links, linked};
}

/** 待ち先が「終わっていない」か。待ちの段と `↳ done` の記録の両方がこの述語で決まる。 */
function isUnfinished(tier: Tier | undefined): boolean {
  return tier !== undefined && tier !== 'review' && tier !== 'stopped';
}

/** 行ごとの、待ちの段を導く前の段と、添える理由。対象外の行は含まない。 */
function classifyAll(rows: readonly AgentRow[]): {own: Map<string, Tier>; reasons: Map<string, string>} {
  const own = new Map<string, Tier>();
  const reasons = new Map<string, string>();
  for (const row of rows) {
    const c = classify(row);
    if (c.tier === null) continue;
    own.set(row.sessionId, c.tier);
    if (c.reason) reasons.set(row.sessionId, c.reason);
  }
  return {own, reasons};
}

/** 待ちの段を導く前の段に、待ち先(と起動された行)の関係から待ちの段を足す。 */
function resolveTiers(
  raw: ReadonlyMap<string, Tier>,
  waits: ReadonlyMap<string, readonly string[]>,
): Map<string, Tier> {
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
      const pending = (waits.get(sid) ?? []).some(t => isUnfinished(resolve(t)));
      visiting.delete(sid);
      if (pending) tier = 'waiting';
    }
    tiers.set(sid, tier);
    return tier;
  };
  for (const sid of raw.keys()) resolve(sid);
  return tiers;
}

function rankKey(tier: Tier, since: number | null, name: string): [number, number, number, string] {
  return [TIERS.indexOf(tier), since === null ? 0 : 1, since ?? 0, name];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareKeys(a: [number, number, number, string], b: [number, number, number, string]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return compareText(a[3], b[3]);
}

/** 一覧を組に分けて並べる。 */
export function arrange(input: ArrangeInput): Arranged {
  const {rows, holds, waits, lastAttached, waitSince, sups} = input;
  const {own: ownTier, reasons} = classifyAll(rows);
  // 段と入れ子は起動された行を含めて決める。
  const {links, linked} = linksWithSpawned(waits, holds, input.spawnedBy, new Set(ownTier.keys()));
  const tiers = resolveTiers(ownTier, links);
  const rowBySid = new Map(rows.map(r => [r.sessionId, r]));
  const visible = (sid: string) => tiers.has(sid);

  // `↳ done` の更新。利用者が結んだ待ち先だけを見る。
  // 待ち先を待っているとは、自分がレビュー待ちに当たり、待ち先のどれかが終わっていないこと(待ち先の段は起動された行を含めて導いたもの)。
  // 起動元が起動された行だけを理由に待ちの段にいる間は、待ち先がすべて終わっていれば記録を持ち越し、表示はしない(下の showDone)。
  const nowWaiting = new Set<string>();
  const done = new Set<string>();
  for (const [sid, targets] of waits) {
    if (!visible(sid) || targets.length === 0) continue;
    const pending = targets.some(t => isUnfinished(tiers.get(t)));
    if (pending) {
      if (ownTier.get(sid) === 'review') nowWaiting.add(sid);
      continue;
    }
    if (input.doneMemo.done.has(sid) || input.doneMemo.waiting.has(sid)) done.add(sid);
  }
  const doneMemo: DoneMemo = {waiting: nowWaiting, done};

  // 待ち元(見えているもの)
  const waiterOf = new Map<string, string>();
  for (const [waiter, targets] of links) {
    if (!visible(waiter)) continue;
    for (const t of targets) if (visible(t)) waiterOf.set(t, waiter);
  }
  // 起動元の下に並ぶ起動された行(起動元が見えていないものは、トップレベルの普通の行になる)。
  const subRows = new Set([...linked].filter(sid => waiterOf.has(sid)));

  const keyOf = (sid: string) => {
    const row = rowBySid.get(sid) as AgentRow;
    return rankKey(tiers.get(sid) as Tier, waitSince.get(sid) ?? null, rowName(row));
  };

  const repoView = input.view === 'repo';
  const touchedOf = (sid: string) => input.touched?.get(sid) ?? 0;
  // 上に来るほうが負。ラダーのビューは段と待機時間の順、リポジトリのビューは触った時刻の新しい順。
  const byName = (a: string, b: string): number =>
    compareText(rowName(rowBySid.get(a) as AgentRow), rowName(rowBySid.get(b) as AgentRow));
  const cmp = (a: string, b: string): number => {
    if (!repoView) return compareKeys(keyOf(a), keyOf(b));
    return touchedOf(b) - touchedOf(a) || byName(a, b);
  };

  const childrenOf = (sid: string): string[] =>
    (links.get(sid) ?? []).filter(t => visible(t) && waiterOf.get(t) === sid).sort(cmp);

  const buildGroup = (root: string): Group => {
    const entries: Entry[] = [];
    let position: string | null = null;
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
        sub: subRows.has(sid),
        midHold,
        holdMark: repoView ? holds.has(sid) : midHold,
        holdReason: holds.get(sid) || undefined,
      };
      // 記録(done)があっても、待ちの段にいる間は出さない。待ちの段の行に done を出すと事実と食い違う。
      const showDone = done.has(sid) && tier !== 'waiting' && targets.length > 0;
      if (showDone) entry.doneNames = targets.map(t => rowName(rowBySid.get(t) as AgentRow));
      entries.push(entry);
      // 起動された行は手を付けられない(attach も f も h も断る)ので、組の位置を決める行に数えない。
      const candidate = !subRows.has(sid) && (!midHold || rootHeld);
      if (!repoView && candidate && (position === null || cmp(sid, position) < 0)) position = sid;
      const kids = childrenOf(sid);
      kids.forEach((kid, i) => {
        walk(kid, depth + 1, [...lastChain, i === kids.length - 1]);
      });
    };
    walk(root, 0, []);
    if (!repoView) return {rootSid: root, entries, positionSid: position ?? root};
    // 保留にしても、待ち先を結んでも、組は動かない。待ち先が組を動かすのは attach したときだけ。
    let at = touchedOf(root);
    let positionSid = root;
    for (const e of entries.slice(1)) {
      const t = input.attachedAt?.get(e.sid);
      if (t !== undefined && t > at) {
        at = t;
        positionSid = e.sid;
      }
    }
    return {rootSid: root, entries, positionSid, at};
  };

  const roots = rows.map(r => r.sessionId).filter(sid => visible(sid) && !waiterOf.has(sid));
  const groups = roots.map(buildGroup);
  if (repoView) groups.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || byName(a.rootSid, b.rootSid));
  else groups.sort((a, b) => cmp(a.positionSid, b.positionSid));

  if (repoView) {
    const byKey = new Map<string, Group[]>();
    for (const g of groups) {
      const key = input.repoOf?.get(g.rootSid) ?? (rowBySid.get(g.rootSid) as AgentRow).cwd;
      const list = byKey.get(key);
      if (list) list.push(g);
      else byKey.set(key, [g]);
    }
    const labels = displayNames([...byKey.keys()]);
    const repos = [...byKey].map(([key, groups], i) => ({key, label: labels[i] as string, groups}));
    repos.sort((a, b) => compareText(a.label, b.label) || compareText(a.key, b.key));
    return {lastAttached: null, upNext: [], onHold: [], repos, doneMemo, tiers, subs: subRows};
  }

  let lastGroup: Group | null = null;
  const upNext: Group[] = [];
  const onHold: Group[] = [];
  for (const g of groups) {
    if (holds.has(g.rootSid)) onHold.push(g);
    else if (lastAttached !== null && lastGroup === null && g.entries.some(e => e.sid === lastAttached)) lastGroup = g;
    else upNext.push(g);
  }
  return {lastAttached: lastGroup, upNext, onHold, doneMemo, tiers, subs: subRows};
}

function allGroups(a: Arranged): Group[] {
  if (a.repos) return a.repos.flatMap(r => r.groups);
  return [a.lastAttached, ...a.upNext, ...a.onHold].filter((g): g is Group => g !== null);
}

/** 組を上から順に並べた行の一覧。 */
export function flatten(a: Arranged): Entry[] {
  return allGroups(a).flatMap(g => g.entries);
}

/** `sid` を含む組と、その中の位置。 */
function locate(a: Arranged, sid: string): {entries: Entry[]; i: number} | null {
  for (const g of allGroups(a)) {
    const i = g.entries.findIndex(e => e.sid === sid);
    if (i >= 0) return {entries: g.entries, i};
  }
  return null;
}

/** `sid` を含む組の行(待ち先の待ち先を含む)。 */
export function subtreeOf(a: Arranged, sid: string): string[] {
  const at = locate(a, sid);
  if (!at) return [sid];
  const depth = at.entries[at.i]?.depth ?? 0;
  const out = [sid];
  for (let j = at.i + 1; j < at.entries.length; j++) {
    const e = at.entries[j] as Entry;
    if (e.depth <= depth) break;
    out.push(e.sid);
  }
  return out;
}

/** 入れ子で `sid` の上に並ぶ行(待ち元か起動元)を、近い順に根まで。 */
export function ancestorsOf(a: Arranged, sid: string): string[] {
  const at = locate(a, sid);
  if (!at) return [];
  const out: string[] = [];
  let depth = at.entries[at.i]?.depth ?? 0;
  for (let j = at.i - 1; j >= 0 && depth > 0; j--) {
    const e = at.entries[j] as Entry;
    if (e.depth < depth) {
      out.push(e.sid);
      depth = e.depth;
    }
  }
  return out;
}
