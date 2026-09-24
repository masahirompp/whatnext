// `claude` と `git`、任意の `ghq` を呼ぶ部分(ADR-0004)
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import type { AgentRow } from './ladder.js';

export type FetchResult = { ok: true; rows: AgentRow[] } | { ok: false; error: string };

function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }>((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 15000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : null) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), error: error ?? undefined });
    });
  });
}

export async function fetchAgents(): Promise<FetchResult> {
  const r = await run('claude', ['agents', '--json', '--all']);
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { ok: false, error: '`claude` command not found in PATH.' };
    const detail = r.stderr.trim() || e.message;
    return { ok: false, error: `\`claude agents --json --all\` failed: ${detail}` };
  }
  let data: unknown;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: 'Could not parse the output of `claude agents --json --all` as JSON.' };
  }
  if (!Array.isArray(data) || !data.every((x) => x && typeof x === 'object' && typeof (x as any).sessionId === 'string')) {
    return { ok: false, error: 'Unexpected shape in the output of `claude agents --json --all`.' };
  }
  return { ok: true, rows: data as AgentRow[] };
}

// 端末に子の設定が残らないように戻す(マウス追跡、代替画面、ブラケットペースト、キーボード拡張など)
const TERMINAL_RESET = [
  '\x1b[?1000l', '\x1b[?1002l', '\x1b[?1003l', '\x1b[?1005l', '\x1b[?1006l', '\x1b[?1015l', // mouse
  '\x1b[?1004l', // focus events
  '\x1b[?2004l', // bracketed paste
  '\x1b[?2026l', // synchronized output
  '\x1b[<999u', // kitty keyboard: pop all
  '\x1b[>4;0m', // xterm modifyOtherKeys off
  '\x1b[?1l', '\x1b>', // cursor keys / keypad normal
  '\x1b[?7h', // autowrap on
  '\x1b[0m', // SGR reset
  '\x1b[?25h', // cursor visible
  '\x1b[?1049l', // leave alternate screen
].join('');

export function resetTerminal() {
  if (process.stdout.isTTY) process.stdout.write(TERMINAL_RESET);
}

// attach している間は whatnext が tty を読まないようにする。
// Ink は入力を止めるとき listener を外すだけで、libuv の読み取りは続くため、子のキー入力を横取りしうる(#4)
function stopReadingStdin() {
  const handle = (process.stdin as any)._handle;
  if (handle && handle.reading) {
    handle.reading = false;
    handle.readStop();
  }
}

// Ctrl+C / Ctrl+Z / Ctrl+\ が子の raw モード前に届いたとき、whatnext ごと落ちたり止まったりしないようにする
const JOB_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTSTP', 'SIGQUIT'];

export async function attach(id: string): Promise<{ code: number | null; signal: string | null; error?: string }> {
  stopReadingStdin();
  const ignore = () => {};
  for (const s of JOB_SIGNALS) process.on(s, ignore);
  try {
    return await new Promise((resolve) => {
      const child = spawn('claude', ['attach', id], { stdio: 'inherit' });
      child.on('error', (e) => resolve({ code: null, signal: null, error: e.message }));
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    for (const s of JOB_SIGNALS) process.off(s, ignore);
    resetTerminal();
  }
}

export async function stopSession(id: string): Promise<{ ok: boolean; message: string }> {
  const r = await run('claude', ['stop', id]);
  if (r.error) return { ok: false, message: (r.stderr.trim() || r.error.message).split('\n')[0] };
  return { ok: true, message: `Stopped session ${id}.` };
}

// 一覧から消す。会話の記録は残る。未コミットの変更や未 push のコミットがある worktree は claude rm が断る(#10)
export async function removeSession(id: string): Promise<{ ok: boolean; message: string }> {
  // claude stop はプロセスが終わる前に戻るので、直後の rm は worktree のロックで断られることがある。
  // 止めたプロセスが終わるまで少し待って再試行する(#16)
  for (let attempt = 0; ; attempt++) {
    const r = await run('claude', ['rm', id]);
    const text = (r.stdout + '\n' + r.stderr).trim().replace(/\s*\n\s*/g, ' ');
    if (!r.error) return { ok: true, message: text };
    if (attempt >= 5 || !/still running/.test(text)) return { ok: false, message: text || r.error.message };
    await new Promise((res) => setTimeout(res, 1000));
  }
}

export async function startSession(opts: { cwd: string; model: string; prompt: string }): Promise<{ ok: boolean; id?: string; message: string }> {
  const args = ['--bg'];
  if (opts.model) args.push('--model', opts.model);
  args.push('--', opts.prompt);
  const r = await run('claude', args, { cwd: opts.cwd, timeout: 60000 });
  const out = r.stdout + r.stderr;
  if (r.error) return { ok: false, message: (r.stderr.trim() || r.error.message).split('\n').slice(-1)[0] };
  const id = out.match(/backgrounded\s*·\s*([0-9a-f]+)/)?.[1];
  return { ok: true, id, message: id ? `Started session ${id}.` : 'Started a new session.' };
}

// `--bg` のセッションの cwd は worktree のパスなので、元のリポジトリのパスに寄せる
export async function repoRoot(dir: string): Promise<string> {
  const r = await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 5000 });
  if (r.error) return dir;
  const common = r.stdout.trim();
  return path.basename(common) === '.git' ? path.dirname(common) : dir;
}


// ghq は任意の依存。無い・失敗したときは候補を足さないだけにする(ADR-0004)
export async function ghqRepos(): Promise<string[]> {
  const r = await run('ghq', ['list', '--full-path'], { timeout: 5000 });
  if (r.error) return [];
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}
