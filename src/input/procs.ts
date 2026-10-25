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
 * 表に pid がない行(`--json` と `ps` を読む間に終わった行、`ps` が読めなかった回)は、
 * 起動元がまだ行に残っていれば前回の関係を持ち越す。持ち越さないと、その1回だけトップレベルに出て、起動元も待ちの段から落ちる。
 * 祖先をたどっても行に当たらなかったとき(読む間に起動元のプロセスが終わり、親が付け替わった)も、
 * 起動元の行がこの回の `--json` でまだ pid を持っていれば持ち越す。次の回には起動元の行の pid が消えるので、持ち越しは続かない。
 * `ps` が読めなかった回に初めて出た行は、前回の関係がないので、その回だけトップレベルに出る。
 */
export function spawners(
  rows: readonly {sessionId: string; pid?: number}[],
  parents: ReadonlyMap<number, number>,
  prev: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const byPid = new Map<number, string>();
  for (const r of rows) if (r.pid !== undefined) byPid.set(r.pid, r.sessionId);
  const present = new Set(rows.map(r => r.sessionId));
  const alive = new Set(rows.filter(r => r.pid !== undefined).map(r => r.sessionId));
  const out = new Map<string, string>();
  const carry = (sid: string, live: boolean) => {
    const before = prev.get(sid);
    if (before !== undefined && (live ? alive : present).has(before)) out.set(sid, before);
  };
  for (const r of rows) {
    if (r.pid === undefined) continue;
    if (!parents.has(r.pid)) {
      carry(r.sessionId, false);
      continue;
    }
    const seen = new Set<number>([r.pid]);
    let p = parents.get(r.pid);
    let found = false;
    while (p !== undefined && p > 1 && !seen.has(p)) {
      const sid = byPid.get(p);
      if (sid !== undefined && sid !== r.sessionId) {
        out.set(r.sessionId, sid);
        found = true;
        break;
      }
      seen.add(p);
      p = parents.get(p);
    }
    if (!found) carry(r.sessionId, true);
  }
  return out;
}
