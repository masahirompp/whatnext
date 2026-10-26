import type {Row, Tier} from './types.js';

/**
 * 待ち先の関係のうち、木として扱えるものだけを残す(PRODUCT.md「依存（待ち先と起動された行）」)。
 * `--json` にない行への関係は残す(削除で切るのは操作の側)。読み飛ばすのは、
 * 待ち元が `(tty)` の行か起動された行、待ち先が起動された行、1つの待ち先を2つ以上の待ち元が待つ、一周する、の関係。
 */
export function validWaits(
  waits: ReadonlyMap<string, readonly string[]>,
  rows: ReadonlyMap<string, Row>,
  spawned: ReadonlySet<string>,
): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const [w, ts] of waits) {
    const wr = rows.get(w);
    if (wr && wr.kind !== 'background') continue;
    if (spawned.has(w)) continue;
    for (const t of new Set(ts)) {
      if (t === w || spawned.has(t)) continue;
      const ps = parents.get(t) ?? [];
      ps.push(w);
      parents.set(t, ps);
    }
  }
  const parent = new Map<string, string>();
  for (const [t, ps] of parents) if (ps.length === 1) parent.set(t, ps[0]);
  // 一周する関係:親をたどって自分に戻る辺をすべて落とす。
  const inCycle = new Set<string>();
  for (const start of parent.keys()) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      path.push(cur);
      cur = parent.get(cur);
    }
    if (cur !== undefined) {
      const i = path.indexOf(cur);
      if (i >= 0) for (const n of path.slice(i)) inCycle.add(n);
    }
  }
  const out = new Map<string, string[]>();
  for (const [w, ts] of waits) {
    for (const t of new Set(ts)) {
      if (parent.get(t) !== w || inCycle.has(t)) continue;
      const list = out.get(w) ?? [];
      list.push(t);
      out.set(w, list);
    }
  }
  return out;
}

/** 待ち先が終わったか。レビュー待ちか停止の段、または一覧に出ていない(対象外)。`--json` にない行は関係が切れたものとして扱う(呼ぶ側で除く)。 */
export function finished(tier: Tier | null): boolean {
  return tier === null || tier === 'review' || tier === 'stopped';
}

/**
 * 待ちの段を導く。待ち元の行がレビュー待ちに当たり、待ち先のどれかが終わっていなければ待ちの段にする。
 * 待ち先が待ち元でもあれば、その行の導いたあとの段で判定する(待ちの段は終わっていない)。
 */
export function deriveTiers(
  rows: ReadonlyMap<string, Row>,
  waits: ReadonlyMap<string, readonly string[]>,
): Map<string, Tier | null> {
  const tier = new Map<string, Tier | null>();
  const visit = (sid: string): Tier | null => {
    if (tier.has(sid)) return tier.get(sid) ?? null;
    const row = rows.get(sid);
    const own = row ? row.tier : null;
    tier.set(sid, own); // 一周は validWaits で落としてあるが、念のため先に置く
    let open = false;
    for (const t of waits.get(sid) ?? []) {
      if (!rows.has(t)) continue;
      if (!finished(visit(t))) open = true;
    }
    const eff = own === 'review' && open ? 'waiting' : own;
    tier.set(sid, eff);
    return eff;
  };
  for (const sid of rows.keys()) visit(sid);
  return tier;
}

/**
 * 待ちが明けて自分の段(レビュー待ち)に戻った待ち元の、今の段に入った時刻(PRODUCT.md「更新と待機時間」)。
 * 自分の時刻、終わった待ち先の時刻(待ち先も待ち元なら、その導いた時刻)、待ちの段を出たのを見た時刻のうち、最も遅いもの。
 * 待ち元でない行と、レビュー待ちでない待ち元は、自分の時刻のまま。
 */
export function stageStarts(
  waits: ReadonlyMap<string, readonly string[]>,
  tier: ReadonlyMap<string, Tier | null>,
  own: ReadonlyMap<string, number | undefined>,
  leftWait: ReadonlyMap<string, number | undefined>,
): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  const visit = (sid: string): number | undefined => {
    if (out.has(sid)) return out.get(sid);
    out.set(sid, own.get(sid)); // 一周は validWaits で落としてあるが、念のため先に置く
    // 待ち先をすべて外したか、すべて削除されて待ちが解けた待ち元は、待ち先がなくても見た時刻で補う
    if (tier.get(sid) !== 'review' || (!waits.has(sid) && !leftWait.has(sid))) return own.get(sid);
    let ended: number | undefined;
    for (const t of waits.get(sid) ?? []) {
      // 一覧に出ていない待ち先(対象外)は時刻が分からないので数えない
      const ta = tier.get(t) ? visit(t) : undefined;
      if (ta !== undefined && (ended === undefined || ta > ended)) ended = ta;
    }
    // 待ち先の時刻がどれも分からないときだけ、待ちの段を出たのを見た時刻(前回の更新時刻。粗い)で補う
    ended ??= leftWait.get(sid);
    const mine = own.get(sid);
    const at = ended === undefined || (mine !== undefined && mine > ended) ? mine : ended;
    out.set(sid, at);
    return at;
  };
  for (const sid of own.keys()) visit(sid);
  return out;
}
