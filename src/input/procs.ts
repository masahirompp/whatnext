// 入力: OS のプロセス表から、行を起動した行(起動元)を導く(PRODUCT.md「起動された行」)。

import type {Run} from './exec.js';

/** `ps` で pid から親の pid を引く表を読む。読めなければ空の表。 */
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
 */
export function spawners(
  rows: readonly {sessionId: string; pid?: number}[],
  parents: ReadonlyMap<number, number>,
): Map<string, string> {
  const byPid = new Map<number, string>();
  for (const r of rows) if (r.pid !== undefined) byPid.set(r.pid, r.sessionId);
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.pid === undefined) continue;
    const seen = new Set<number>([r.pid]);
    let p = parents.get(r.pid);
    while (p !== undefined && p > 1 && !seen.has(p)) {
      const sid = byPid.get(p);
      if (sid !== undefined && sid !== r.sessionId) {
        out.set(r.sessionId, sid);
        break;
      }
      seen.add(p);
      p = parents.get(p);
    }
  }
  return out;
}
