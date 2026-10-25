// `↳ <名前> done` の出し入れ(PRODUCT.md「依存（待ち先と起動された行）」)。
// 状態のファイルには書かず、起動し直したあとは観測から導き直す(起動した直後の観測では出さない)。

export interface DoneEntry {
  /** 前の観測で終わっていなかった待ち先。 */
  unfinished: string[];
  /** `done` を出している待ち先(名前は描くときに今の名前で引く)。 */
  done: string[];
}

export type DoneState = Map<string, DoneEntry>;

export interface DoneObservation {
  /** `--json` にある行。 */
  present: ReadonlySet<string>;
  /** 木として扱える待ち先の関係。 */
  waits: ReadonlyMap<string, readonly string[]>;
  /** 待ち元ごとの、終わっていない待ち先。 */
  unfinished: ReadonlyMap<string, readonly string[]>;
}

/**
 * 次の状態を導く。待ち先のどれかが終わっていない状態から、すべて終わった状態に移ったときに `done` を出す。
 * 終わっていなかった待ち先がすべて `--json` から消えた(削除された)だけなら出さない。
 * `f` で外したことで待ちが解けたとき(外した行はまだ `--json` にある)は出す。
 */
export function nextDone(prev: DoneState | undefined, obs: DoneObservation): DoneState {
  const out: DoneState = new Map();
  for (const [w, ts] of obs.waits) {
    if (!obs.present.has(w)) continue;
    const targets = ts.filter(t => obs.present.has(t));
    const open = [...(obs.unfinished.get(w) ?? [])];
    const before = prev?.get(w);
    let done: string[] = [];
    if (open.length === 0 && before) {
      const resolved = before.unfinished.some(t => obs.present.has(t));
      if (resolved) done = targets;
      else done = before.done.filter(t => targets.includes(t));
    }
    if (targets.length === 0 && open.length === 0 && done.length === 0) continue;
    out.set(w, {unfinished: open, done});
  }
  return out;
}

/** 待ち元に attach したときと、新しく待ち先を結んだときに `done` を消す。 */
export function clearDone(state: DoneState, w: string): DoneState {
  const e = state.get(w);
  if (!e || e.done.length === 0) return state;
  const out = new Map(state);
  out.set(w, {...e, done: []});
  return out;
}
