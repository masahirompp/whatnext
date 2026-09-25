// Account usage from `claude -p "/usage"`: a local command, so no model call and no rate limit spent.
import os from 'node:os';
import { run } from './agents.js';

export type Limit = { label: string; percent: number; resets: string | null };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Reads `Current <label>: <N>% used · resets <when> (<tz>)` lines. The text is for humans,
// so anything else is ignored and an empty result means "could not read".
export function parseUsage(text: string, today = new Date()): Limit[] {
  const todayText = `${MONTHS[today.getMonth()]} ${today.getDate()}`;
  const out: Limit[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*Current (.+?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets (.+?))?\s*(?:\([^)]*\))?\s*$/);
    if (!m) continue;
    let resets = m[3]?.replace(' at ', ' ') ?? null;
    if (resets?.startsWith(`${todayText} `)) resets = resets.slice(todayText.length + 1);
    out.push({ label: m[1], percent: Number(m[2]), resets });
  }
  return out;
}

export async function fetchUsage(): Promise<Limit[]> {
  // Run outside any project so its settings and hooks are not picked up.
  const r = await run('claude', ['-p', '/usage', '--no-session-persistence', '--output-format', 'json'],
    { cwd: os.tmpdir(), timeout: 20000 });
  if (r.code !== 0) return [];
  try {
    const d = JSON.parse(r.stdout) as { result?: unknown };
    return typeof d.result === 'string' ? parseUsage(d.result) : [];
  } catch {
    return [];
  }
}
