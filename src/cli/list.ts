import {accessSync, appendFileSync, constants} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {emitKeypressEvents} from 'node:readline';
import {fetchUsage} from '../../lib/input/claude.js';
import {run} from '../../lib/input/exec.js';
import {launchSettings, openReceiver, probe} from '../../lib/input/receiver.js';
import {Transcripts} from '../../lib/input/transcript.js';
import {LIST, serverConfig, Tmux} from '../../lib/tmux/tmux.js';
import {DigestHookStore} from '../input/digest.js';
import {Observer} from '../input/observe.js';
import {Locations, Prs} from '../input/where.js';
import {App} from '../ops/app.js';
import {startGuide} from '../ops/guide-session.js';
import {ATTACH_KEYS, ATTACH_KEYS_HELP} from '../ops/keys.js';
import {DIGEST_LIVE} from '../ops/names.js';
import {StateFile, statePath} from '../state/state.js';
import {type Env, modDir, paneCommand, tmuxEnv, workbenchCommand} from './env.js';

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

  const hooks = new DigestHookStore(env.digest);
  let settings: string | undefined;
  let pluginDir: string | undefined;
  const occupant = await probe(env.port);
  if (occupant === 'free') {
    const rec = await openReceiver(env.port, hooks);
    if (rec) {
      settings = launchSettings(env.port);
      // ダイジェストの mod は、受け口を開けたときだけ付ける(フックと同じ。DESIGN.md「ダイジェストの mod」)
      if (env.digest) pluginDir = modDir();
    }
  }
  // ダイジェストが有効なのに受け口を開けなかったときは、右の欄にその理由を出す(シナリオ 41 の「エラーを示さない」の例外。--no-digest では出さない)
  const digestOff = env.digest && !settings ? digestOffText(occupant, env.port) : undefined;
  log(
    `start ${env.version} port=${env.port} occupant=${occupant} receiver=${settings ? 'open' : 'none'} digest=${env.digest}`,
  );

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
  // mod が「ダイジェストを受けているか」を確かめる口(受け口を開けて mod を付けるときだけ置く)
  if (settings && pluginDir) {
    const sock = (await tmux.t(['display-message', '-p', '-t', `=${LIST}:`, '#{socket_path}'])).stdout.trim();
    settings = withDigestEnv(settings, {
      WHATNEXT_DIGEST_PORT: String(env.port),
      WHATNEXT_DIGEST_TMUX: findTmux(),
      ...(sock ? {WHATNEXT_DIGEST_SOCKET: sock} : {}),
    });
    // 一覧のセッションのオプションに置く。一覧のプロセスがどう終わっても(シグナル、SIGKILL)一覧のセッションごと消え、
    // 作業台のためにサーバが残っても、mod は受けていないと読む
    await tmux.t(['set', '-t', `=${LIST}:`, DIGEST_LIVE, String(env.port)]);
  }
  const guideCommand = paneCommand(env, 'guide');
  await startGuide(tmux, guideCommand, homedir());

  const transcripts = new Transcripts(configDir);
  const app_ = new App({
    run: runT,
    tmux,
    observer: new Observer(runT, hooks, transcripts, Date.now, env.digest ? hooks : undefined),
    locations: new Locations(runT),
    prs: new Prs(runT),
    transcripts,
    hooks,
    stateFile: new StateFile(statePath(process.env)),
    fetchUsage: () => fetchUsage(runT),
    now: Date.now,
    refreshMs: env.refreshMs,
    usageMinMs: env.usageMinMs,
    write: s => process.stdout.write(s),
    size: () => ({cols: process.stdout.columns || 80, rows: process.stdout.rows || 24}),
    settings,
    pluginDir,
    digest: env.digest,
    digestOff,
    socket: env.socket,
    port: env.port,
    version: env.version,
    workbenchCommand: workbenchCommand(env),
    guideCommand,
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

/** `--settings` の JSON の `env` に、ダイジェストの mod が読む値(送る先のポート、受けているかを確かめる tmux)を足す。 */
export function withDigestEnv(settings: string, add: Record<string, string>): string {
  try {
    const j = JSON.parse(settings) as {env?: Record<string, string>};
    j.env = {...(j.env ?? {}), ...add};
    return JSON.stringify(j);
  } catch {
    return settings;
  }
}

/** tmux の実行ファイルの絶対パス(`claude --bg` のセッションの PATH に tmux があるとは限らない)。なければ `tmux`。 */
export function findTmux(path = process.env.PATH ?? ''): string {
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const p = join(dir, 'tmux');
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return 'tmux';
}

/** 受け口を開けなかった理由の文言(右の欄。ダイジェストが有効なときだけ)。 */
export function digestOffText(occupant: 'free' | 'whatnext' | 'other', port: number): string {
  if (occupant === 'other') return `Digests are off: port ${port} is used by another program.`;
  if (occupant === 'whatnext') return `Digests are off: port ${port} is used by another whatnext.`;
  return `Digests are off: could not open port ${port}.`;
}
