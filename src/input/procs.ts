// 入力: OS のプロセス表から、行を起動した行(起動元)を導く(PRODUCT.md「起動された行」)。

import type {Run} from './exec.js';

/**
 * `ps` で pid から親の pid を引く表を読む。読めなければ空の表。
 * 作業台の `⚙` も `ps -A` を読むが(tmux のモジュール)、まとめない。境界をまたいで表を渡す口が要るわりに、`ps` 1回は軽い。
 * 同じ理由で、起動元がありえない更新(`pid` を持つ行が2つ未満)でも省かない。
 */
export async function readParents(run: Run): Promise<Map<number, number>> {
  const r = await run('ps', ['-A', '-o', 'pid=,ppid='], {timeout: 5000});
  return r.code === 0 ? parseParents(r.stdout) : new Map();
}

export function parseParents(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

/**
 * 各行の pid の祖先をたどり、最初に当たった別の行を起動元とする。
 * `sessionId` から起動元の `sessionId` への表を返す。
 * `background` の行は、起動された行にしない(祖先は Claude Code の常駐プロセスで、起動された行のように扱うと Enter や削除の扱いと食い違う)。
 *
 * 前回の関係を持ち越す場面が2つある。
 * - 表に pid がない行(`--json` と `ps` を読む間に終わった行、`ps` が読めなかった回): 起動元がまだ行に残っていれば持ち越す。
 *   持ち越さないと、その1回だけトップレベルに出て、起動元も待ちの段から落ちる。
 * - 祖先をたどっても行に当たらない行(読む間に起動元のプロセスが終わった、間のシェルが終わって親が pid 1 に付け替わった):
 *   起動元の行がこの回の `--json` でまだ pid を持っていれば持ち越す。起動元が止まって pid がなくなれば、そこで持ち越しは終わる。
 *   間のシェルだけが終わったときは、起動元が動いている間は持ち越し続ける(その行を起動したのは起動元なので、入れ子のままにする)。
 * `ps` が読めなかった回に初めて出た行は、前回の関係がないので、その回だけトップレベルに出る。
 */
export function spawners(
  rows: readonly {sessionId: string; pid?: number; kind?: string}[],
  parents: ReadonlyMap<number, number>,
  prev: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const byPid = new Map<number, string>();
  for (const r of rows) if (r.pid !== undefined) byPid.set(r.pid, r.sessionId);
  const present = new Set(rows.map(r => r.sessionId));
  const alive = new Set(byPid.values());

  /** pid の祖先で最初に当たった、自分以外の行。 */
  const nearestRow = (self: string, pid: number): string | undefined => {
    const seen = new Set<number>([pid]);
    let p = parents.get(pid);
    while (p !== undefined && p > 1 && !seen.has(p)) {
      const sid = byPid.get(p);
      if (sid !== undefined && sid !== self) return sid;
      seen.add(p);
      p = parents.get(p);
    }
    return undefined;
  };
  /** 前回の起動元が、まだ行に残っていれば(`mustBeAlive` なら pid を持っていれば)それを返す。 */
  const carriedOver = (sid: string, mustBeAlive: boolean): string | undefined => {
    const before = prev.get(sid);
    return before !== undefined && (mustBeAlive ? alive : present).has(before) ? before : undefined;
  };

  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.pid === undefined || r.kind === 'background') continue;
    const spawner = parents.has(r.pid)
      ? (nearestRow(r.sessionId, r.pid) ?? carriedOver(r.sessionId, true))
      : carriedOver(r.sessionId, false);
    if (spawner !== undefined) out.set(r.sessionId, spawner);
  }
  return out;
}
