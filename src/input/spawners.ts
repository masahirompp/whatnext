import type {Run} from '../../lib/input/exec.js';

// 起動された行の起動元を導く(DESIGN.md「起動元の引き方」、ADR-0019)。

export interface ProcRow {
  sid: string;
  kind: string;
  pid?: number;
}

/** `ps -E` の出力から、pid ごとの `MCP_CALLER_PID` を読む。環境変数はコマンド行のあとに続くので、最後に当たった語を採る。 */
export function parseCallerPids(text: string): Map<number, number | null> {
  const out = new Map<number, number | null>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!m) continue;
    const all = [...m[2].matchAll(/(?:^|\s)MCP_CALLER_PID=(\d+)(?=\s|$)/g)];
    const last = all.at(-1);
    out.set(Number(m[1]), last ? Number(last[1]) : null);
  }
  return out;
}

export async function readCallerPids(run: Run, pids: readonly number[]): Promise<Map<number, number | null>> {
  if (pids.length === 0) return new Map();
  const r = await run('ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')], {timeout: 5000});
  const out = r.code === null ? new Map<number, number | null>() : parseCallerPids(r.stdout);
  // 表に出なかった pid(読むあいだに終わった)は覚えない
  return out;
}

export interface SpawnerDeps {
  /** pid から親の pid を引く表(読めなければ空)。 */
  parents: ReadonlyMap<number, number>;
  /** 前回の関係(起動された行 → 起動元)。 */
  prev: ReadonlyMap<string, string>;
  /** 祖先から分からない行の pid について `MCP_CALLER_PID` を返す(値がなければ null)。 */
  callerPid: (pids: number[]) => Promise<Map<number, number | null>>;
}

/**
 * 起動された行 → 起動元の表を返す。`background` の行は起動された行にしない。
 * 祖先をたどって最初に当たった `--json` の別の行を起動元とし、当たらなければ `MCP_CALLER_PID`、
 * それもなければ前回の関係を持ち越す(起動元の行がまだ `pid` を持つときだけ)。
 */
export async function deriveSpawners(rows: readonly ProcRow[], deps: SpawnerDeps): Promise<Map<string, string>> {
  const bySid = new Map(rows.map(r => [r.sid, r]));
  const sidOfPid = new Map<number, string>();
  for (const r of rows) if (r.pid !== undefined) sidOfPid.set(r.pid, r.sid);
  const out = new Map<string, string>();
  const unresolved: ProcRow[] = [];
  const tableEmpty = deps.parents.size === 0;
  for (const r of rows) {
    if (r.kind === 'background') continue;
    const before = deps.prev.get(r.sid);
    if (r.pid === undefined || tableEmpty || !deps.parents.has(r.pid)) {
      // 表に pid がない回は、起動元がまだ行に残っていれば持ち越す
      if (before !== undefined && bySid.has(before)) out.set(r.sid, before);
      continue;
    }
    let found: string | undefined;
    const seen = new Set<number>();
    for (let p = deps.parents.get(r.pid); p !== undefined && p > 1 && !seen.has(p); p = deps.parents.get(p)) {
      seen.add(p);
      const s = sidOfPid.get(p);
      if (s !== undefined && s !== r.sid) {
        found = s;
        break;
      }
    }
    if (found !== undefined) out.set(r.sid, found);
    else unresolved.push(r);
  }
  if (unresolved.length > 0) {
    const callers = await deps.callerPid(unresolved.map(r => r.pid as number));
    for (const r of unresolved) {
      const c = callers.get(r.pid as number);
      const s = c != null ? sidOfPid.get(c) : undefined;
      if (s !== undefined && s !== r.sid) {
        out.set(r.sid, s);
        continue;
      }
      const before = deps.prev.get(r.sid);
      if (before !== undefined && bySid.get(before)?.pid !== undefined) out.set(r.sid, before);
    }
  }
  return out;
}

/** `MCP_CALLER_PID` を pid ごとに覚える(環境変数はプロセスが生きている間に変わらない)。 */
export class CallerCache {
  private cache = new Map<number, number | null>();
  constructor(private readonly run: Run) {}

  async get(pids: number[]): Promise<Map<number, number | null>> {
    const missing = pids.filter(p => !this.cache.has(p));
    if (missing.length > 0) {
      const got = await readCallerPids(this.run, missing);
      for (const [p, v] of got) this.cache.set(p, v);
    }
    return new Map(pids.filter(p => this.cache.has(p)).map(p => [p, this.cache.get(p) ?? null]));
  }

  /** `--json` に出ていない pid を忘れる。 */
  keep(pids: ReadonlySet<number>): void {
    for (const p of [...this.cache.keys()]) if (!pids.has(p)) this.cache.delete(p);
  }
}
