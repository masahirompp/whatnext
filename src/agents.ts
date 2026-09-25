// Thin wrappers around the `claude` CLI (ADR-0001: state comes only from `claude agents --json`).
import { execFile } from 'node:child_process';
import { OTEL_SETTINGS } from './otel.js';
import type { AgentRow } from './rank.js';

export type Run = { code: number; stdout: string; stderr: string };

export function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 30000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        let code = 0;
        if (e) code = typeof e.code === 'number' ? e.code : -1;
        if (e && e.code === 'ENOENT') stderr = `${cmd}: command not found`;
        else if (e && typeof e.code === 'string') stderr = `${stderr}${e.message}`;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    // Nothing is piped in; `claude -p` otherwise waits 3s for stdin before running.
    child.stdin?.end();
  });
}

export async function listAgents(): Promise<AgentRow[]> {
  const r = await run('claude', ['agents', '--json', '--all']);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `claude agents exited with ${r.code}`);
  let data: unknown;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new Error(`Could not parse the output of claude agents --json: ${r.stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(data)) throw new Error('Unexpected output of claude agents --json (not an array)');
  return data.filter((x): x is AgentRow => !!x && typeof x === 'object' && typeof x.sessionId === 'string');
}

export const stop = (id: string) => run('claude', ['stop', id]);
export const rm = (id: string, discard?: string) =>
  run('claude', discard ? ['rm', id, '--discard-unpushed', discard] : ['rm', id]);

// `claude --bg` without a prompt. Returns the new id if it could be read from the output.
export async function launch(cwd: string, model: string): Promise<{ id?: string; out: string; code: number }> {
  const args = ['--bg', '--settings', OTEL_SETTINGS];
  if (model) args.push('--model', model);
  const r = await run('claude', args, { cwd });
  const out = `${r.stdout}${r.stderr}`.trim();
  const m = out.match(/backgrounded\s*·\s*([0-9a-f]+)/);
  return { id: r.code === 0 ? m?.[1] : undefined, out, code: r.code };
}
