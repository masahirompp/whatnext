import { spawn, spawnSync } from 'node:child_process';
import { run } from './exec.js';
import { parseAgentsJson, type RawRow } from './model.js';
import { otelListening, otelSettingsJson } from './otel.js';

export async function listAgents(): Promise<RawRow[]> {
  if (process.env.WHATNEXT_DEMO) return (await import('./demo.js')).demoRows;
  const r = await run('claude', ['agents', '--json', '--all'], { timeoutMs: 20000 });
  if (r.error) throw new Error(r.error.includes('ENOENT') ? '`claude` was not found on PATH.' : r.error);
  if (r.code !== 0) throw new Error(`claude agents --json failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  try {
    return parseAgentsJson(r.stdout);
  } catch (e) {
    throw new Error(`Could not parse claude agents --json output: ${(e as Error).message}`);
  }
}

export async function stopSession(id: string) {
  return run('claude', ['stop', id], { timeoutMs: 30000 });
}

export type RmOutcome =
  | { kind: 'removed' }
  | { kind: 'unpushed'; count: number; discard: string; message: string }
  | { kind: 'locked'; message: string }
  | { kind: 'refused'; message: string };

export async function removeSession(id: string, discard?: string): Promise<RmOutcome> {
  const args = ['rm', id, ...(discard ? ['--discard-unpushed', discard] : [])];
  const r = await run('claude', args, { timeoutMs: 60000 });
  const message = `${r.stdout}\n${r.stderr}`.trim() || r.error || `exit ${r.code}`;
  if (r.code === 0) return { kind: 'removed' };
  const d = message.match(/--discard-unpushed[ =]+(\S+@\S+)/);
  if (d) {
    const n = message.match(/(\d+) unpushed commit/);
    return { kind: 'unpushed', count: n ? Number(n[1]) : 1, discard: d[1].replace(/[`'".,]+$/, ''), message };
  }
  if (/still (at|running|in use)|lock/i.test(message) && !/uncommitted|modified|changes/i.test(message)) return { kind: 'locked', message };
  return { kind: 'refused', message };
}

export type LaunchResult = { id?: string; output: string; code: number };

export async function launchBg(cwd: string, model?: string): Promise<LaunchResult> {
  const args = ['--bg'];
  if (model) args.push('--model', model);
  if (otelListening()) args.push('--settings', otelSettingsJson());
  const r = await run('claude', args, { cwd, timeoutMs: 120000 });
  const output = `${r.stdout}${r.stderr}`.trim() || r.error || '';
  const m = output.match(/backgrounded\s*·\s*([0-9a-f]{6,})/i);
  return { id: r.code === 0 ? m?.[1] : undefined, output, code: r.code };
}

// ---- attach: hand the terminal to `claude attach` ----

const RESET_MODES =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l' + // mouse tracking
  '\x1b[?1004l' + // focus events
  '\x1b[?2004l' + // bracketed paste
  '\x1b[?25h' + // show cursor
  '\x1b[<u' + // kitty keyboard pop
  '\x1b[>4;0m'; // modifyOtherKeys off

function sttySave(): string | undefined {
  const r = spawnSync('stty', ['-g'], { stdio: ['inherit', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.toString().trim() : undefined;
}
function sttyRestore(saved: string | undefined) {
  if (saved) spawnSync('stty', [saved], { stdio: ['inherit', 'ignore', 'ignore'] });
}

function waitKey(stdin: NodeJS.ReadStream): Promise<void> {
  return new Promise((resolve) => {
    stdin.setRawMode?.(true);
    const onData = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      resolve();
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

/**
 * Runs `claude <args>` with the terminal. Must be called inside Ink's
 * suspendTerminal callback. On non-zero exit, keeps the child's message on
 * screen until a key is pressed.
 */
export async function runInTerminal(args: string[], opts: { cwd?: string; pauseMessage?: string } = {}): Promise<number> {
  const stdin = process.stdin as NodeJS.ReadStream & { _handle?: any; _readableState?: any };
  // Leave Ink's readable handler before touching the stream.
  await new Promise((r) => setImmediate(r));
  const listeners = stdin.listeners('readable') as ((...a: unknown[]) => void)[];
  for (const l of listeners) stdin.removeListener('readable', l);
  try {
    if (stdin._handle) {
      stdin._handle.reading = false;
      stdin._handle.readStop?.();
    }
  } catch {
    // best effort
  }
  const saved = sttySave();
  const ignore = () => {};
  const sigs: NodeJS.Signals[] = ['SIGINT', 'SIGTSTP', 'SIGQUIT'];
  for (const s of sigs) process.on(s, ignore);
  let code: number;
  try {
    code = await new Promise<number>((resolve) => {
      const child = spawn('claude', args, { stdio: 'inherit', cwd: opts.cwd });
      child.on('error', () => resolve(127));
      child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 : 1)));
    });
  } finally {
    for (const s of sigs) process.removeListener(s, ignore);
  }
  sttyRestore(saved);
  process.stdout.write(RESET_MODES);
  try {
    if (stdin._readableState) stdin._readableState.reading = false;
  } catch {
    // best effort
  }
  if (code !== 0) {
    process.stdout.write(`\r\n${opts.pauseMessage ?? `claude ${args[0]} exited with code ${code}.`} Press any key to return to the list.\r\n`);
    await waitKey(stdin);
    sttyRestore(saved);
  }
  // Leave the child's alternate screen, if any.
  process.stdout.write('\x1b[?1049l');
  for (const l of listeners) stdin.addListener('readable', l);
  stdin.read(0);
  return code;
}
