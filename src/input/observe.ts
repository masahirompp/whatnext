import {readAgents} from '../../lib/input/claude.js';
import type {Run} from '../../lib/input/exec.js';
import {type HookStore, type Supplied, supplement} from '../../lib/input/hooks.js';
import {readParents} from '../../lib/input/procs.js';
import type {Transcripts} from '../../lib/input/transcript.js';
import {type AgentRow, classify, dedupe, rowName, type Tier} from '../../lib/tier/classify.js';
import {CallerCache, deriveSpawners} from './spawners.js';

// 1回の更新の観測(DESIGN.md「モジュールの境界」の入力)。取得の失敗は観測の一部として返す。

export interface ObsRow {
  sid: string;
  id?: string;
  kind: 'background' | 'interactive';
  name: string;
  cwd: string;
  pid?: number;
  /** 行そのものの段(null は対象外)。 */
  tier: Tier | null;
  reason?: string;
}

export type Observation =
  | {ok: true; at: number; rows: ObsRow[]; spawner: Map<string, string>; supplied: Map<string, Supplied>}
  | {ok: false; at: number; error: string};

export class Observer {
  private callers: CallerCache;
  private prevSpawner = new Map<string, string>();

  constructor(
    private readonly run: Run,
    private readonly hooks: HookStore,
    private readonly transcripts: Transcripts,
    private readonly now: () => number = Date.now,
  ) {
    this.callers = new CallerCache(run);
  }

  async observe(): Promise<Observation> {
    const at = this.now();
    const [agents, parents] = await Promise.all([readAgents(this.run), readParents(this.run)]);
    if (!agents.ok) return {ok: false, at, error: agents.error};
    const rows: ObsRow[] = dedupe(agents.rows as AgentRow[]).map(r => {
      const c = classify(r);
      return {
        sid: r.sessionId,
        id: r.id,
        kind: r.kind === 'background' ? 'background' : 'interactive',
        name: rowName(r),
        cwd: r.cwd,
        pid: r.pid,
        tier: c.tier,
        reason: c.reason,
      };
    });
    this.callers.keep(new Set(rows.flatMap(r => (r.pid === undefined ? [] : [r.pid]))));
    const spawner = await deriveSpawners(rows, {
      parents,
      prev: this.prevSpawner,
      callerPid: pids => this.callers.get(pids),
    });
    this.prevSpawner = spawner;
    const keep = new Set(rows.map(r => r.sid));
    this.hooks.forget(keep);
    this.transcripts.forget(keep);
    const supplied = new Map<string, Supplied>();
    await Promise.all(
      rows
        .filter(r => r.tier !== null)
        .map(async r => {
          const tr = await this.transcripts.read(r.sid).catch(() => undefined);
          supplied.set(r.sid, supplement(this.hooks.get(r.sid), tr, this.hooks.ctxOf(r.sid)));
        }),
    );
    return {ok: true, at, rows, spawner, supplied};
  }
}
