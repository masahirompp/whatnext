// Hook events from sessions whatnext launched: the one-line summary under each
// row and the time a session entered its current tier. Memory only (ADR-0002).
import type { Tier } from './model.js';

type Mark = { text: string; at: number };
type HookStats = {
  prompt?: Mark; // UserPromptSubmit
  message?: Mark; // Stop
  failure?: Mark; // StopFailure
  permission?: Mark; // PermissionRequest
  question?: Mark; // PreToolUse(AskUserQuestion)
  waitAt?: number; // last event that leaves the session waiting for a human
};

const stats = new Map<string, HookStats>();

function get(sid: string) {
  let s = stats.get(sid);
  if (!s) stats.set(sid, (s = {}));
  return s;
}

const MAX = 300;

/** First meaningful line of a message, without markdown decoration. */
export function firstLine(t: unknown): string {
  if (typeof t !== 'string') return '';
  for (const raw of t.split('\n')) {
    let l = raw.trim();
    if (!l || /^(```|-{3,}|\*{3,}|_{3,}|\|)/.test(l)) continue;
    l = l
      .replace(/^(#+|>|[-*+]|\d+[.)])\s+/, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
    if (l) return l.length > MAX ? l.slice(0, MAX) : l;
  }
  return '';
}

export function describeTool(name: unknown, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'path', 'query', 'prompt']
    .map((k) => i[k])
    .find((v) => typeof v === 'string' && v.trim());
  const detail = pick !== undefined ? firstLine(pick) : Object.keys(i).length ? JSON.stringify(i).slice(0, MAX) : '';
  const n = typeof name === 'string' ? name : 'tool';
  return detail ? `${n}: ${detail}` : n;
}

function questionText(input: any): string {
  const q = Array.isArray(input?.questions) ? input.questions[0] : undefined;
  return firstLine(q?.question ?? q?.header ?? '');
}

export function ingestHook(body: any, now = Date.now()) {
  const sid = body?.session_id;
  if (typeof sid !== 'string') return;
  const s = get(sid);
  switch (body.hook_event_name) {
    case 'UserPromptSubmit':
      s.prompt = { text: firstLine(body.prompt), at: now };
      break;
    case 'Stop':
      s.message = { text: firstLine(body.last_assistant_message), at: now };
      s.waitAt = now;
      break;
    case 'StopFailure':
      s.failure = { text: firstLine(body.error_details) || firstLine(String(body.error ?? '')) || firstLine(body.last_assistant_message), at: now };
      s.waitAt = now;
      break;
    case 'PermissionRequest':
      s.permission = { text: describeTool(body.tool_name, body.tool_input), at: now };
      s.waitAt = now;
      break;
    case 'PreToolUse':
      if (body.tool_name === 'AskUserQuestion') {
        s.question = { text: questionText(body.tool_input), at: now };
        s.waitAt = now;
      }
      break;
  }
}

/** Marks from before the latest prompt belong to an earlier turn. */
function current(s: HookStats, m: Mark | undefined) {
  return m && m.text && m.at >= (s.prompt?.at ?? 0) ? m : undefined;
}

function latest(...ms: (Mark | undefined)[]) {
  return ms.filter((m): m is Mark => !!m).sort((a, b) => b.at - a.at)[0];
}

/** One line for the row: what it is doing (Working) or what it left for you. */
export function summaryFor(sid: string, tier: Tier): string | undefined {
  const s = stats.get(sid);
  if (!s) return undefined;
  switch (tier) {
    case 'Working':
      return s.prompt?.text ? `→ ${s.prompt.text}` : undefined;
    case 'Permission':
      return current(s, s.permission)?.text;
    case 'Question':
      return latest(current(s, s.question), current(s, s.message))?.text;
    case 'Failed':
      return latest(current(s, s.failure), current(s, s.message))?.text;
    default:
      return current(s, s.message)?.text;
  }
}

/** When the session entered this tier, as far as hooks tell. */
export function hookSince(sid: string, tier: Tier): number | undefined {
  const s = stats.get(sid);
  if (!s) return undefined;
  if (tier === 'Working') return s.prompt?.at;
  if (s.waitAt === undefined || s.waitAt < (s.prompt?.at ?? 0)) return undefined;
  return s.waitAt;
}

export function promptedAfter(sid: string, t: number) {
  const at = stats.get(sid)?.prompt?.at;
  return at !== undefined && at > t;
}

/**
 * `hooks` for --settings. The command holds no path to whatnext, so it keeps
 * working after whatnext moves, and it stays silent when nobody listens.
 */
export function hooksSettings(port: number) {
  const command = `curl -s -m 1 -o /dev/null --data-binary @- http://127.0.0.1:${port}/v1/hooks; exit 0`;
  const hooks = [{ type: 'command', command, timeout: 5 }];
  return {
    UserPromptSubmit: [{ hooks }],
    Stop: [{ hooks }],
    StopFailure: [{ hooks }],
    PermissionRequest: [{ hooks }],
    PreToolUse: [{ matcher: 'AskUserQuestion', hooks }],
  };
}
