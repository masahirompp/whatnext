// 入力: whatnext が起動したセッションから受けるフックと OTel の値(メモリにだけ持つ)。

import {firstLine, leadLine, toolTarget} from './text.js';
import type {TranscriptFacts} from './transcript.js';

export interface HookFacts {
  prompt?: {text: string; at: number};
  /** 受けた UserPromptSubmit の数(作業したかの判定に、前後の差だけを使う)。 */
  promptCount: number;
  stop?: {at: number; text?: string};
  failure?: {at: number; error?: string};
  permission?: {at: number; target: string};
  question?: {at: number; text: string};
}

export type HookListener = (sid: string, event: string) => void;

export class HookStore {
  private bySid = new Map<string, HookFacts>();
  private ctx = new Map<string, number>();
  private listeners: HookListener[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  onEvent(l: HookListener): void {
    this.listeners.push(l);
  }

  get(sid: string): HookFacts | undefined {
    return this.bySid.get(sid);
  }

  ctxOf(sid: string): number | undefined {
    return this.ctx.get(sid);
  }

  /** フックの入力(JSON)を1つ受ける。 */
  receiveHook(body: unknown): void {
    if (!body || typeof body !== 'object') return;
    const b = body as Record<string, unknown>;
    const sid = b.session_id;
    const event = b.hook_event_name;
    if (typeof sid !== 'string' || typeof event !== 'string') return;
    const at = this.now();
    const f = this.bySid.get(sid) ?? {promptCount: 0};
    switch (event) {
      case 'UserPromptSubmit': {
        const text = typeof b.prompt === 'string' ? firstLine(b.prompt) : undefined;
        f.promptCount++;
        f.prompt = text !== undefined ? {text, at} : undefined;
        f.stop = undefined;
        f.failure = undefined;
        f.permission = undefined;
        f.question = undefined;
        break;
      }
      case 'Stop': {
        const msg = typeof b.last_assistant_message === 'string' ? b.last_assistant_message : '';
        f.stop = {at, text: leadLine(msg)};
        break;
      }
      case 'StopFailure': {
        const msg = typeof b.last_assistant_message === 'string' ? leadLine(b.last_assistant_message) : undefined;
        const code = typeof b.error === 'string' ? b.error : undefined;
        f.failure = {at, error: msg ?? code};
        break;
      }
      case 'PermissionRequest':
        f.permission = {at, target: toolTarget(String(b.tool_name ?? ''), b.tool_input)};
        break;
      case 'PreToolUse': {
        if (b.tool_name !== 'AskUserQuestion') return;
        const q = (b.tool_input as {questions?: {question?: string}[]} | undefined)?.questions?.[0]?.question;
        if (q) f.question = {at, text: q};
        break;
      }
      default:
        return;
    }
    this.bySid.set(sid, f);
    for (const l of this.listeners) l(sid, event);
  }

  /** OTLP/HTTP(JSON)の logs を1つ受け、本体のターンの api_request から CTX を取る。 */
  receiveLogs(body: unknown): void {
    const resourceLogs = (body as {resourceLogs?: unknown[]} | undefined)?.resourceLogs;
    if (!Array.isArray(resourceLogs)) return;
    for (const rl of resourceLogs) {
      const resAttrs = attrs((rl as {resource?: {attributes?: unknown}})?.resource?.attributes);
      for (const sl of ((rl as {scopeLogs?: unknown[]}).scopeLogs ?? []) as {logRecords?: unknown[]}[]) {
        for (const rec of (sl.logRecords ?? []) as {attributes?: unknown; body?: {stringValue?: string}}[]) {
          const a = {...resAttrs, ...attrs(rec.attributes)};
          const name = String(a['event.name'] ?? rec.body?.stringValue ?? '');
          if (!name.endsWith('api_request')) continue;
          const sid = a['session.id'];
          const source = String(a.query_source ?? '');
          if (typeof sid !== 'string' || !source.startsWith('repl_main_thread')) continue;
          const n = (k: string) => Number(a[k] ?? 0) || 0;
          this.ctx.set(sid, n('input_tokens') + n('cache_read_tokens') + n('cache_creation_tokens'));
        }
      }
    }
  }

  forget(keep: ReadonlySet<string>): void {
    for (const k of this.bySid.keys()) if (!keep.has(k)) this.bySid.delete(k);
    for (const k of this.ctx.keys()) if (!keep.has(k)) this.ctx.delete(k);
  }
}

function attrs(list: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list as {key?: string; value?: Record<string, unknown>}[]) {
    if (!kv?.key || !kv.value) continue;
    const v = kv.value;
    out[kv.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
  }
  return out;
}

/** 補う値(段と並びに渡す形)。フックの値を主にし、今のターンの値がないときに会話記録で補う。 */
export interface Supplied {
  prompt?: {text: string; at: number};
  haltAt?: number;
  permission?: string;
  question?: string;
  declined?: string;
  error?: string;
  lastText?: string;
  ctx?: number;
}

const SLACK = 5000;

export function supplement(
  hook: HookFacts | undefined,
  tr: TranscriptFacts | undefined,
  ctx: number | undefined,
): Supplied {
  const turn = Math.max(hook?.prompt?.at ?? -Infinity, tr?.prompt?.at ?? -Infinity);
  const fresh = (at: number | undefined) => at !== undefined && at >= turn - SLACK;
  const trCurrent = tr !== undefined && (turn === -Infinity || fresh(tr.prompt?.at));
  const out: Supplied = {};
  if (ctx !== undefined) out.ctx = ctx;

  if (hook?.prompt && fresh(hook.prompt.at)) out.prompt = hook.prompt;
  else if (tr?.prompt) out.prompt = tr.prompt;

  const hookHalt = [hook?.stop?.at, hook?.failure?.at, hook?.permission?.at, hook?.question?.at].filter(fresh);
  if (hookHalt.length > 0) out.haltAt = Math.max(...(hookHalt as number[]));
  else if (trCurrent && tr?.haltAt !== undefined) out.haltAt = tr.haltAt;

  const pick = <T>(hv: {at: number} | undefined, value: T | undefined, trv: T | undefined): T | undefined =>
    hv && fresh(hv.at) && value !== undefined ? value : trCurrent ? trv : undefined;

  out.lastText = pick(hook?.stop, hook?.stop?.text, tr?.lastText);
  out.error = pick(hook?.failure, hook?.failure?.error, tr?.error);
  out.question = pick(hook?.question, hook?.question?.text, tr?.question);
  const permHook = hook?.permission && fresh(hook.permission.at) ? hook.permission : undefined;
  out.permission = permHook ? permHook.target : trCurrent ? tr?.permission : undefined;
  const stoppedAfter = permHook && hook?.stop && hook.stop.at >= permHook.at;
  out.declined = permHook && !stoppedAfter ? permHook.target : trCurrent ? tr?.declined : undefined;
  for (const k of Object.keys(out) as (keyof Supplied)[]) if (out[k] === undefined) delete out[k];
  return out;
}
