// 入力: `claude` の読み取り(`agents --json --all`、`/usage`)。

import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Run} from './exec.js';

export interface JsonRow {
  kind: string;
  sessionId: string;
  id?: string;
  cwd: string;
  name?: string;
  startedAt?: number;
  pid?: number;
  state?: string;
  status?: string;
  waitingFor?: string;
}

export type AgentsResult = {ok: true; rows: JsonRow[]} | {ok: false; error: string};

/** `claude agents --json --all` を読む。 */
export async function readAgents(run: Run): Promise<AgentsResult> {
  const r = await run('claude', ['agents', '--json', '--all'], {timeout: 20000});
  if (r.error === 'ENOENT') return {ok: false, error: 'claude: command not found'};
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || r.error || '').trim().split('\n')[0] ?? '';
    return {ok: false, error: `claude agents --json failed${r.code !== null ? ` (exit ${r.code})` : ''}: ${msg}`};
  }
  return parseAgents(r.stdout);
}

export function parseAgents(text: string): AgentsResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {ok: false, error: 'Could not parse the output of claude agents --json.'};
  }
  if (!Array.isArray(data)) return {ok: false, error: 'Could not parse the output of claude agents --json.'};
  const rows: JsonRow[] = [];
  for (const o of data) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    if (typeof r.sessionId !== 'string' || typeof r.kind !== 'string') continue;
    const row: JsonRow = {kind: r.kind, sessionId: r.sessionId, cwd: typeof r.cwd === 'string' ? r.cwd : ''};
    for (const k of ['id', 'name', 'state', 'status', 'waitingFor'] as const)
      if (typeof r[k] === 'string') row[k] = r[k] as string;
    if (typeof r.pid === 'number') row.pid = r.pid;
    if (typeof r.startedAt === 'number') row.startedAt = r.startedAt;
    rows.push(row);
  }
  return {ok: true, rows};
}

export interface UsageFrame {
  label: string;
  percent: number;
  resets?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `/usage` の結果の文字列から枠を読む。 */
export function parseUsage(text: string, now: Date): UsageFrame[] {
  const frames: UsageFrame[] = [];
  for (const line of text.split('\n')) {
    const m = /Current ([^:]+):\s*(\d+)% used(?:\s*·\s*resets\s+(.+))?/.exec(line.trim());
    if (!m) continue;
    const frame: UsageFrame = {label: (m[1] as string).trim(), percent: Number(m[2])};
    if (m[3]) frame.resets = formatReset(m[3], now);
    frames.push(frame);
  }
  return frames;
}

function formatReset(s: string, now: Date): string {
  const t = s
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+at\s+/, ' ')
    .trim();
  const m = /^([A-Z][a-z]{2}) (\d{1,2}) (.+)$/.exec(t);
  if (m && MONTHS.indexOf(m[1] as string) === now.getMonth() && Number(m[2]) === now.getDate()) return m[3] as string;
  return t;
}

/** `claude -p "/usage"` を一時ディレクトリで動かして読む。読めなければ undefined。 */
export async function fetchUsage(run: Run, now: () => Date = () => new Date()): Promise<UsageFrame[] | undefined> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), 'whatnext-usage-'));
  } catch {
    return undefined;
  }
  const r = await run('claude', ['-p', '/usage', '--no-session-persistence', '--output-format', 'json'], {
    cwd: dir,
    timeout: 60000,
  });
  if (r.code !== 0) return undefined;
  let result: unknown;
  try {
    result = (JSON.parse(r.stdout) as {result?: unknown}).result;
  } catch {
    return undefined;
  }
  if (typeof result !== 'string') return undefined;
  const frames = parseUsage(result, now());
  return frames.length > 0 ? frames : undefined;
}
