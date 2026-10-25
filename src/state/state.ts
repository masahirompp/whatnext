import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

// 状態のファイル(DESIGN.md「状態のファイルに書くもの」、ADR-0016、ADR-0018)。

export interface Seen {
  first: number;
  attached?: number;
}

export interface PersistedState {
  notes: Map<string, string>;
  waits: Map<string, string[]>;
  seen: Map<string, Seen>;
}

export const emptyState = (): PersistedState => ({notes: new Map(), waits: new Map(), seen: new Map()});

export function statePath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const socket = env.WHATNEXT_TMUX_SOCKET || 'whatnext';
  const file = socket === 'whatnext' ? 'state.json' : `state-${socket}.json`;
  return join(base, 'whatnext', file);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type Parsed = {kind: 'ok'; state: PersistedState} | {kind: 'missing'} | {kind: 'unreadable'};

/** 文字列を読む。版 1〜3 のほかの版と壊れた中身は読めないものとして返す。 */
export function parseState(text: string): Parsed {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return {kind: 'unreadable'};
  }
  if (!isObj(j)) return {kind: 'unreadable'};
  const v = j.version;
  if (v !== 1 && v !== 2 && v !== 3) return {kind: 'unreadable'};
  const s = emptyState();
  if (v === 3) {
    if (isObj(j.notes)) for (const [k, n] of Object.entries(j.notes)) if (typeof n === 'string' && n) s.notes.set(k, n);
  } else if (isObj(j.holds)) {
    for (const [k, h] of Object.entries(j.holds)) {
      const reason = typeof h === 'string' ? h : isObj(h) && typeof h.reason === 'string' ? h.reason : '';
      if (reason) s.notes.set(k, reason);
    }
  }
  if (isObj(j.waits)) {
    for (const [k, ts] of Object.entries(j.waits)) {
      if (!Array.isArray(ts)) continue;
      const list = ts.filter((t): t is string => typeof t === 'string');
      if (list.length > 0) s.waits.set(k, list);
    }
  }
  if (v !== 1 && isObj(j.seen)) {
    for (const [k, t] of Object.entries(j.seen)) {
      if (!isObj(t) || typeof t.first !== 'number') continue;
      s.seen.set(k, typeof t.attached === 'number' ? {first: t.first, attached: t.attached} : {first: t.first});
    }
  }
  return {kind: 'ok', state: s};
}

export function serialize(s: PersistedState): string {
  const sorted = <T>(m: Map<string, T>) => Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  return `${JSON.stringify(
    {
      version: 3,
      notes: sorted(s.notes),
      waits: sorted(new Map([...s.waits].filter(([, ts]) => ts.length > 0))),
      seen: sorted(s.seen),
    },
    null,
    2,
  )}\n`;
}

/**
 * 状態のファイル。読めなかった(壊れているか知らない版の)ファイルは、利用者がメモか待ち先を変えるまで置き換えない。
 * 書くのは中身が前に書いたものと違うときだけで、一時ファイルに書いてから置き換える。書けなくても止めない。
 */
export class StateFile {
  private last: string | undefined;
  private protect = false;

  constructor(readonly path: string) {}

  load(): PersistedState {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return emptyState();
    }
    const p = parseState(text);
    if (p.kind === 'ok') {
      this.last = text;
      return p.state;
    }
    this.protect = p.kind === 'unreadable';
    return emptyState();
  }

  /** 書く。`annotated` は利用者がメモか待ち先を変えたときに true。 */
  save(s: PersistedState, annotated: boolean): boolean {
    if (annotated) this.protect = false;
    if (this.protect) return false;
    const text = serialize(s);
    if (text === this.last) return false;
    try {
      mkdirSync(dirname(this.path), {recursive: true});
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, this.path);
      this.last = text;
      return true;
    } catch {
      return false;
    }
  }
}
