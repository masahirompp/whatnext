// 入力: OS のプロセス表(pid から親の pid を引く表)を読む(docs/lib/input.md)。起動元の導き方は使う側が持つ。

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
