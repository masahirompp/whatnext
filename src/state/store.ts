// 状態のファイル: 保留と待ち先の関係を `state.json` に書き、起動し直しても引き継ぐ(ADR-0016)。

import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

export interface Relations {
  holds: Map<string, string>;
  waits: Map<string, string[]>;
}

export function statePath(env: NodeJS.ProcessEnv, socket: string): string {
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const file = socket === 'whatnext' ? 'state.json' : `state-${socket}.json`;
  return join(base, 'whatnext', file);
}

/** 読む。`version` が違う、壊れている、ないときは空として読む。 */
export async function loadState(path: string): Promise<Relations> {
  const empty = {holds: new Map<string, string>(), waits: new Map<string, string[]>()};
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return empty;
  }
  const d = data as {version?: unknown; holds?: unknown; waits?: unknown};
  if (!d || typeof d !== 'object' || d.version !== 1) return empty;
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
  return {holds, waits};
}

export function serialize(r: Relations): string {
  const holds: Record<string, string> = {};
  for (const k of [...r.holds.keys()].sort()) holds[k] = r.holds.get(k) as string;
  const waits: Record<string, string[]> = {};
  for (const k of [...r.waits.keys()].sort()) {
    const v = r.waits.get(k) as string[];
    if (v.length > 0) waits[k] = [...v];
  }
  return `${JSON.stringify({version: 1, holds, waits}, null, 2)}\n`;
}

/** 前に書いたものと違うときだけ、一時ファイルに書いてから置き換える。書けなくても例外を投げない。 */
export class StateWriter {
  private last: string | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    initial?: Relations,
  ) {
    if (initial) this.last = serialize(initial);
  }

  save(r: Relations): Promise<void> {
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
