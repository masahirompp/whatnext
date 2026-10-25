// 入力: 会話記録(`<設定>/projects/*/<sessionId>.jsonl`)から一言、待機時間、作業したかを補う(ADR-0011)。
// 読むだけで書き込まない。読んだ値はメモリにだけ持つ。

import {open, readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {instructionText, leadLine, toolTarget} from './text.js';

export interface TranscriptFacts {
  prompt?: {text: string; at: number};
  haltAt?: number;
  permission?: string;
  question?: string;
  declined?: string;
  error?: string;
  lastText?: string;
}

interface Pending {
  name: string;
  input: unknown;
}

interface FileState {
  path: string;
  offset: number;
  mtimeMs: number;
  size: number;
  prompt?: {text: string; at: number};
  lastText?: string;
  pending: Map<string, Pending>;
  declined?: string;
  error?: string;
  lastAt?: number;
}

const TAIL = 512 * 1024;
const MAX_BACK = 16 * 1024 * 1024;
const HEAD = 2 * 1024 * 1024;

const DECLINE_MARK = "doesn't want to proceed";

function ts(o: Record<string, unknown>): number | undefined {
  const t = o.timestamp;
  if (typeof t !== 'string') return undefined;
  const n = Date.parse(t);
  return Number.isNaN(n) ? undefined : n;
}

/** 1行を読んで状態を進める。 */
function apply(st: FileState, line: string): void {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (!o || typeof o !== 'object' || o.isSidechain === true) return;
  const at = ts(o);
  const msg = o.message as {content?: unknown} | undefined;
  if (o.type === 'user') {
    const c = msg?.content;
    if (typeof c === 'string') {
      if (o.isMeta === true || o.isCompactSummary === true) return;
      const text = instructionText(c);
      if (text === undefined || at === undefined) return;
      st.prompt = {text, at};
      st.lastText = undefined;
      st.pending.clear();
      st.declined = undefined;
      st.error = undefined;
      st.lastAt = undefined;
      return;
    }
    if (Array.isArray(c)) {
      for (const item of c) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
          const p = st.pending.get(item.tool_use_id);
          st.pending.delete(item.tool_use_id);
          const body = typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? '');
          if (p && body.includes(DECLINE_MARK)) st.declined = toolTarget(p.name, p.input);
        }
      }
      if (at !== undefined && st.prompt) st.lastAt = at;
    }
    return;
  }
  if (o.type === 'assistant') {
    const c = msg?.content;
    if (o.isApiErrorMessage === true) {
      const text = Array.isArray(c)
        ? c
            .filter(x => x && x.type === 'text')
            .map(x => x.text)
            .join('\n')
        : typeof c === 'string'
          ? c
          : '';
      st.error = leadLine(text) ?? text;
    } else if (Array.isArray(c)) {
      for (const item of c) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text' && typeof item.text === 'string') {
          const lead = leadLine(item.text);
          if (lead !== undefined) st.lastText = lead;
        } else if (item.type === 'tool_use' && typeof item.id === 'string') {
          st.pending.set(item.id, {name: String(item.name ?? ''), input: item.input});
        }
      }
    }
    if (at !== undefined && st.prompt) st.lastAt = at;
    return;
  }
  if (o.type === 'system' && o.subtype === 'turn_duration' && at !== undefined && st.prompt) st.lastAt = at;
}

function facts(st: FileState): TranscriptFacts {
  const f: TranscriptFacts = {};
  if (st.prompt) f.prompt = st.prompt;
  if (st.lastText) f.lastText = st.lastText;
  if (st.declined) f.declined = st.declined;
  if (st.error) f.error = st.error;
  if (st.lastAt !== undefined) f.haltAt = st.lastAt;
  for (const p of st.pending.values()) {
    if (p.name === 'AskUserQuestion') {
      const q = (p.input as {questions?: {question?: string}[]} | undefined)?.questions?.[0]?.question;
      if (q) f.question = q;
    } else f.permission = toolTarget(p.name, p.input);
  }
  return f;
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    const {bytesRead} = await fh.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** 改行で終わる完全な行と、読み終えた位置。`skipFirst` なら最初の改行までを捨てる(途中から読んだとき)。 */
function completeLines(buf: Buffer, base: number, skipFirst = false): {lines: string[]; end: number} {
  let from = 0;
  if (skipFirst) {
    const nl = buf.indexOf(10);
    if (nl < 0) return {lines: [], end: base};
    from = nl + 1;
  }
  const last = buf.lastIndexOf(10);
  if (last < from) return {lines: [], end: base + from};
  const lines = buf.subarray(from, last).toString('utf8').split('\n');
  return {lines, end: base + last + 1};
}

export class Transcripts {
  private files = new Map<string, FileState>();
  private paths = new Map<string, string>();
  private firsts = new Map<string, {text?: string; size: number}>();

  constructor(private readonly configDir: string) {}

  /** `sessionId` の会話記録を探す。見つからなければ undefined(覚えずに、次に呼ばれたときに探し直す)。 */
  async locate(sid: string): Promise<string | undefined> {
    const known = this.paths.get(sid);
    if (known) {
      try {
        await stat(known);
        return known;
      } catch {
        this.paths.delete(sid);
      }
    }
    const root = join(this.configDir, 'projects');
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      return undefined;
    }
    for (const d of dirs) {
      const p = join(root, d, `${sid}.jsonl`);
      try {
        await stat(p);
        this.paths.set(sid, p);
        return p;
      } catch {}
    }
    return undefined;
  }

  /** 前に読んだときから変わっていれば、増えた分だけ読む。読めなければ undefined。 */
  async read(sid: string): Promise<TranscriptFacts | undefined> {
    try {
      const path = await this.locate(sid);
      if (!path) return undefined;
      const s = await stat(path);
      let st = this.files.get(sid);
      if (st && st.path === path && st.mtimeMs === s.mtimeMs && st.size === s.size) return facts(st);
      if (!st || st.path !== path || s.size < st.offset) {
        st = await this.initial(path, s.size);
      } else {
        const text = await readRange(path, st.offset, s.size);
        const {lines, end} = completeLines(text, st.offset);
        for (const l of lines) apply(st, l);
        st.offset = end;
      }
      st.mtimeMs = s.mtimeMs;
      st.size = s.size;
      this.files.set(sid, st);
      return facts(st);
    } catch {
      return undefined;
    }
  }

  private async initial(path: string, size: number): Promise<FileState> {
    let back = TAIL;
    for (;;) {
      const start = Math.max(0, size - back);
      const st: FileState = {path, offset: 0, mtimeMs: 0, size, pending: new Map()};
      const buf = await readRange(path, start, size);
      const {lines, end} = completeLines(buf, start, start > 0);
      for (const l of lines) apply(st, l);
      st.offset = end;
      if (st.prompt || start === 0 || back >= MAX_BACK) return st;
      back *= 4;
    }
  }

  /** 最初の依頼(概要の行に出す)。先頭から最大 2MB を読む。一度見つけたら読み直さない。 */
  async firstPrompt(sid: string, force = false): Promise<string | undefined> {
    const known = this.firsts.get(sid);
    if (known?.text !== undefined) return known.text;
    try {
      const path = await this.locate(sid);
      if (!path) return undefined;
      const s = await stat(path);
      if (!force && known && known.size === s.size) return undefined;
      const text = await readRange(path, 0, Math.min(s.size, HEAD));
      const {lines} = completeLines(text, 0);
      for (const line of lines) {
        if (!line.includes('"user"')) continue;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type !== 'user' || o.isSidechain === true || o.isMeta === true) continue;
        const c = (o.message as {content?: unknown} | undefined)?.content;
        if (typeof c !== 'string') continue;
        const t = instructionText(c);
        if (t !== undefined) {
          this.firsts.set(sid, {text: t, size: s.size});
          return t;
        }
      }
      this.firsts.set(sid, {size: s.size});
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** 一覧に出なくなったセッションの記憶を捨てる。 */
  forget(keep: ReadonlySet<string>): void {
    for (const m of [this.files, this.paths, this.firsts]) for (const k of m.keys()) if (!keep.has(k)) m.delete(k);
  }
}
