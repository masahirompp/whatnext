// 状態のファイル: 保留と待ち先の関係(ADR-0016)と、ビューと触った時刻(ADR-0018)を `state.json` に書き、起動し直しても引き継ぐ。

import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

export interface Relations {
  holds: Map<string, string>;
  waits: Map<string, string[]>;
}

export type View = 'ladder' | 'repo';

/** 一覧に初めて出た時刻と、whatnext から最後に attach した時刻。 */
export interface Seen {
  first: number;
  attached?: number;
}

export interface State extends Relations {
  view: View;
  seen: Map<string, Seen>;
}

const VERSION = 2;

export function statePath(env: NodeJS.ProcessEnv, socket: string): string {
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const file = socket === 'whatnext' ? 'state.json' : `state-${socket}.json`;
  return join(base, 'whatnext', file);
}

/** 読む。版 1 は保留と待ち先の関係だけを読む。ほかの版、壊れている、ないときは空として読む。 */
export async function loadState(path: string): Promise<State> {
  const empty: State = {holds: new Map(), waits: new Map(), view: 'ladder', seen: new Map()};
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return empty;
  }
  const d = data as {version?: unknown; holds?: unknown; waits?: unknown; view?: unknown; seen?: unknown};
  if (!d || typeof d !== 'object' || (d.version !== 1 && d.version !== VERSION)) return empty;
  const holds = new Map<string, string>();
  if (d.holds && typeof d.holds === 'object')
    for (const [k, v] of Object.entries(d.holds as Record<string, unknown>)) if (typeof v === 'string') holds.set(k, v);
  const waits = new Map<string, string[]>();
  if (d.waits && typeof d.waits === 'object')
    for (const [k, v] of Object.entries(d.waits as Record<string, unknown>))
      if (Array.isArray(v)) {
        const ts = v.filter((x): x is string => typeof x === 'string');
        if (ts.length > 0) waits.set(k, ts);
      }
  if (d.version === 1) return {...empty, holds, waits};
  const view: View = d.view === 'repo' ? 'repo' : 'ladder';
  const seen = new Map<string, Seen>();
  if (d.seen && typeof d.seen === 'object')
    for (const [k, v] of Object.entries(d.seen as Record<string, unknown>)) {
      const e = v as {first?: unknown; attached?: unknown} | null;
      if (!e || typeof e.first !== 'number') continue;
      seen.set(k, typeof e.attached === 'number' ? {first: e.first, attached: e.attached} : {first: e.first});
    }
  return {holds, waits, view, seen};
}

export function serialize(r: State): string {
  const holds: Record<string, string> = {};
  for (const k of [...r.holds.keys()].sort()) holds[k] = r.holds.get(k) as string;
  const waits: Record<string, string[]> = {};
  for (const k of [...r.waits.keys()].sort()) {
    const v = r.waits.get(k) as string[];
    if (v.length > 0) waits[k] = [...v];
  }
  const seen: Record<string, Seen> = {};
  for (const k of [...r.seen.keys()].sort()) seen[k] = {...(r.seen.get(k) as Seen)};
  return `${JSON.stringify({version: VERSION, holds, waits, view: r.view, seen}, null, 2)}\n`;
}

/** 前に書いたものと違うときだけ、一時ファイルに書いてから置き換える。書けなくても例外を投げない。 */
export class StateWriter {
  private last: string | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    initial?: State,
  ) {
    if (initial) this.last = serialize(initial);
  }

  /** 書きかけの分が終わるのを待つ。 */
  flush(): Promise<void> {
    return this.writing;
  }

  save(r: State): Promise<void> {
    const text = serialize(r);
    if (text === this.last) return this.writing;
    this.last = text;
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.path), {recursive: true});
        const tmp = `${this.path}.${process.pid}.tmp`;
        await writeFile(tmp, text);
        await rename(tmp, this.path);
      } catch {
        // 書けなかったときは、次に変わったときにまた書く。
        this.last = undefined;
      }
    });
    return this.writing;
  }
}
