import os from 'node:os';
import { run } from './exec.js';

export type UsageItem = { label: string; percent: number; resets?: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Read `Current <label>: <N>% used · resets <time>` lines. */
export function parseUsage(text: string, now = new Date()): UsageItem[] {
  const today = `${MONTHS[now.getMonth()]} ${now.getDate()}`;
  const items: UsageItem[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*Current ([^:]+):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?\s*$/);
    if (!m) continue;
    let resets = m[3]?.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (resets) {
      const d = resets.match(/^([A-Z][a-z]{2} \d{1,2})(?: at)? (.+)$/);
      if (d) resets = d[1] === today ? d[2] : `${d[1]} ${d[2]}`;
    }
    items.push({ label: m[1].trim(), percent: Number(m[2]), resets });
  }
  return items;
}

export async function fetchUsage(): Promise<UsageItem[] | null> {
  const r = await run('claude', ['-p', '/usage', '--no-session-persistence', '--output-format', 'json'], {
    cwd: os.tmpdir(),
    timeoutMs: 30000,
  });
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const items = parseUsage(String(j.result ?? ''));
    return items.length ? items : null;
  } catch {
    return null;
  }
}
