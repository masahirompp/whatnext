import {appendFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {emitKeypressEvents} from 'node:readline';
import {fetchUsage} from '../../lib/input/claude.js';
import {run} from '../../lib/input/exec.js';
import {HookStore} from '../../lib/input/hooks.js';
import {launchSettings, openReceiver, probe} from '../../lib/input/receiver.js';
import {Transcripts} from '../../lib/input/transcript.js';
import {GUIDE, LIST, serverConfig, Tmux} from '../../lib/tmux/tmux.js';
import {Observer} from '../input/observe.js';
import {Locations, Prs} from '../input/where.js';
import {App} from '../ops/app.js';
import {ATTACH_KEYS, ATTACH_KEYS_HELP} from '../ops/keys.js';
import {StateFile, statePath} from '../state/state.js';
import {type Env, paneCommand, shq, tmuxEnv} from './env.js';

// 一覧の役(専用の tmux サーバのセッション `list` の中で動く)。本物の口を差し込んで App を動かす。

export async function startList(env: Env): Promise<number> {
  const logPath = process.env.WHATNEXT_DEBUG_LOG;
  const log = (msg: string) => {
    if (!logPath) return;
    try {
      appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
    } catch {}
  };
  // フック(client-attached など)は設定を入れた直後から SIGUSR2 を送るので、先に受け手を付ける
  let app: App | undefined;
  process.on('SIGUSR2', () => app?.signal());

  const baseEnv = tmuxEnv();
  const runT: typeof run = (cmd, args, opts) => run(cmd, args, {...opts, env: opts?.env ?? baseEnv});
  const tmux = new Tmux(env.socket, runT);
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const claudeJson = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homedir(), '.claude.json');

  const hooks = new HookStore();
  let settings: string | undefined;
  const occupant = await probe(env.port);
  if (occupant === 'free') {
    const rec = await openReceiver(env.port, hooks);
    if (rec) settings = launchSettings(env.port);
  }
  log(`start ${env.version} port=${env.port} occupant=${occupant} receiver=${settings ? 'open' : 'none'}`);

  const r = await tmux.sourceConfig(
    serverConfig({
      socket: env.socket,
      listPid: process.pid,
      version: env.version,
      env: {
        WHATNEXT_ROLE: 'list',
        WHATNEXT_TMUX_SOCKET: env.socket,
        WHATNEXT_PORT: String(env.port),
      },
      keys: ATTACH_KEYS,
      keysHelp: ATTACH_KEYS_HELP,
    }),
  );
  if (r.code !== 0) log(`sourceConfig failed: ${r.stderr}`);
  await tmux.t(['set', '-w', '-t', `=${LIST}:`, 'remain-on-exit', 'off']);
  if (!(await tmux.hasSession(GUIDE))) {
    await tmux.t(['new-session', '-d', '-s', GUIDE, '-c', homedir(), paneCommand(env, 'guide')]);
  }
  await tmux.workbenchOptions(GUIDE, '');

  const transcripts = new Transcripts(configDir);
  const app_ = new App({
    run: runT,
    tmux,
    observer: new Observer(runT, hooks, transcripts),
    locations: new Locations(runT),
    prs: new Prs(runT),
    transcripts,
    hooks,
    stateFile: new StateFile(statePath(process.env)),
    fetchUsage: () => fetchUsage(runT),
    now: Date.now,
    write: s => process.stdout.write(s),
    size: () => ({cols: process.stdout.columns || 80, rows: process.stdout.rows || 24}),
    settings,
    socket: env.socket,
    port: env.port,
    version: env.version,
    workbenchCommand: `exec ${shq(env.node)} ${shq(env.cli)} workbench`,
    launchDir: process.cwd(),
    claudeJson,
    home: homedir(),
    log,
    exit: code => process.exit(code),
  });
  app = app_;

  // 端末
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
  emitKeypressEvents(process.stdin, {escapeCodeTimeout: 30} as never);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (s, k) => app_.onKey(s, k));
  if (logPath) process.stdin.on('data', b => log(`stdin ${Buffer.from(b).toString('hex')}`));
  process.stdout.on('resize', () => app_.draw());

  let ending = false;
  const abnormal = async (why: string) => {
    if (ending) return;
    ending = true;
    log(`abnormal exit: ${why}`);
    try {
      await app_.abnormalExit();
    } finally {
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void abnormal('SIGTERM'));
  process.on('SIGHUP', () => void abnormal('SIGHUP'));
  process.on('uncaughtException', e => void abnormal(e.stack ?? String(e)));
  process.on('unhandledRejection', e => log(`unhandled rejection: ${e instanceof Error ? e.stack : String(e)}`));

  await app_.start();
  return await new Promise<number>(() => {});
}
