import { spawn } from 'node:child_process';

export type ExecResult = { code: number; stdout: string; stderr: string; error?: string };

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: ExecResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ code: -1, stdout, stderr, error: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -1, stdout, stderr, error: `${cmd} timed out` });
    }, opts.timeoutMs ?? 30000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => finish({ code: -1, stdout, stderr, error: e.message }));
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
  });
}
