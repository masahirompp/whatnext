// cli: 一覧のプロセス(専用の tmux サーバのセッション `list` の中で動く)。

import {spawnSync} from 'node:child_process';
import {readFile, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {emitKeypressEvents} from 'node:readline';
import {fetchUsage, readAgents} from '../input/claude.js';
import {run} from '../input/exec.js';
import {HookStore, supplement} from '../input/hooks.js';
import {placeOf, pullRequestOf} from '../input/place.js';
import {launchSettings, openReceiver, type Receiver} from '../input/receiver.js';
import {Transcripts} from '../input/transcript.js';
import {App, type Key} from '../ops/app.js';
import type {Observed, Ports} from '../ops/ports.js';
import {loadState, StateWriter, statePath} from '../state/store.js';
import {focusWorkbench, splitWorkbench} from '../tmux/ghostty.js';
import {GUIDE, LIST, serverConfig, shq, Tmux} from '../tmux/tmux.js';
import type {Settings} from './args.js';

/** 一覧の役として動くのは、`WHATNEXT_ROLE=list` があり、自分のペインが専用サーバのセッション `list` にあるときだけ。 */
export function isListRole(env: NodeJS.ProcessEnv, s: Settings): boolean {
  if (env.WHATNEXT_ROLE !== 'list' || !env.TMUX_PANE) return false;
  const r = spawnSync('tmux', ['-L', s.socket, 'display-message', '-p', '-t', env.TMUX_PANE, '#{session_name}'], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() === LIST;
}

const ALT_ON = '\x1b[?1049h\x1b[?25l\x1b[?2004h';
const ALT_OFF = '\x1b[?2004l\x1b[?25h\x1b[?1049l';

export async function runList(s: Settings, version: string, distDir: string, cliPath: string): Promise<void> {
  const tmux = new Tmux(s.socket, run);
  await tmux.sourceConfig(
    serverConfig({
      socket: s.socket,
      listPid: process.pid,
      version,
      env: {WHATNEXT_ROLE: 'list', WHATNEXT_TMUX_SOCKET: s.socket, WHATNEXT_PORT: String(s.port)},
    }),
  );
  await tmux.unsetOption('@wn_newer');

  // 前の一覧が残したもの: 残した attach と何も動いていない作業台は捨て、動いているものがある作業台は聞く。
  const leftovers = new Map<string, string[]>();
  const running = await tmux.running();
  for (const name of await tmux.sessions()) {
    if (name === LIST) continue;
    if (name.startsWith('sh-') && running.has(name.slice(3))) {
      leftovers.set(name.slice(3), running.get(name.slice(3)) as string[]);
      continue;
    }
    await tmux.killSession(name);
  }
  // 案内のセッション(同じ版のプログラムで作り直す)
  await tmux.t([
    'new-session',
    '-d',
    '-s',
    GUIDE,
    `exec ${shq(process.execPath)} ${shq(join(distDir, 'cli', 'guide.js'))}`,
  ]);
  await tmux.t(['set', '-w', '-t', `=${GUIDE}:`, 'remain-on-exit', 'off']);
  await tmux.workbenchOptions(GUIDE, '');

  const env = process.env;
  const home = homedir();
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const store = new HookStore();
  const receiver: Receiver | null = await openReceiver(s.port, store);
  const transcripts = new Transcripts(configDir);
  const path = statePath(env, s.socket);
  const relations = await loadState(path);
  const writer = new StateWriter(path, relations);

  const write = (str: string) => process.stdout.write(str);
  let app: App;

  const cleanupAndExit = (code: number) => {
    // 確認を出せずに終わるとき: 残した attach と何も動いていない作業台を畳み、動いているものがある作業台だけを残す。
    try {
      const sessions = spawnSync('tmux', ['-L', s.socket, 'list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf8',
      });
      const names = (sessions.stdout ?? '').split('\n').filter(Boolean);
      const panes = spawnSync('tmux', ['-L', s.socket, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'], {
        encoding: 'utf8',
      });
      const ps = spawnSync('ps', ['-A', '-o', 'pid=,tpgid='], {encoding: 'utf8'});
      const tp = new Map<number, number>();
      for (const l of (ps.stdout ?? '').split('\n')) {
        const m = /^\s*(\d+)\s+(-?\d+)/.exec(l);
        if (m) tp.set(Number(m[1]), Number(m[2]));
      }
      const busy = new Set<string>();
      for (const l of (panes.stdout ?? '').split('\n')) {
        const [n, pid] = l.split('\t');
        const g = tp.get(Number(pid));
        if (n?.startsWith('sh-') && g !== undefined && g > 0 && g !== Number(pid)) busy.add(n);
      }
      for (const n of names) {
        if (n === LIST || busy.has(n)) continue;
        spawnSync('tmux', ['-L', s.socket, 'kill-session', '-t', `=${n}`]);
      }
    } catch {}
    process.stdout.write(ALT_OFF);
    process.exit(code);
  };

  const ports: Ports = {
    now: () => Date.now(),
    readAgents: () => readAgents(run),
    observe: async rows => {
      const out = new Map<string, Observed>();
      await Promise.all(
        rows.map(async r => {
          const hook = store.get(r.sessionId);
          const tr = await transcripts.read(r.sessionId);
          out.set(r.sessionId, {
            sup: supplement(hook, tr, store.ctxOf(r.sessionId)),
            activity: (hook?.promptCount ?? 0) + (tr?.activity ?? 0),
          });
        }),
      );
      const keep = new Set(rows.map(r => r.sessionId));
      transcripts.forget(keep);
      store.forget(keep);
      return out;
    },
    place: cwd => placeOf(run, cwd),
    pullRequest: (cwd, branch) => pullRequestOf(run, cwd, branch),
    usage: () => fetchUsage(run),
    firstPrompt: (sid, force) => transcripts.firstPrompt(sid, force),
    ghqList: async () => {
      const r = await run('ghq', ['list', '-p'], {timeout: 10000});
      return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
    },
    isDirectory: async p => {
      try {
        return (await stat(p)).isDirectory();
      } catch {
        return false;
      }
    },
    trusted: async dir => {
      try {
        const file = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json');
        const data = JSON.parse(await readFile(file, 'utf8')) as {
          projects?: Record<string, {hasTrustDialogAccepted?: boolean}>;
        };
        return data.projects?.[dir]?.hasTrustDialogAccepted === true;
      } catch {
        return false;
      }
    },
    stop: id => run('claude', ['stop', id], {timeout: 60000}),
    remove: (id, discard) =>
      run('claude', ['rm', id, ...(discard ? ['--discard-unpushed', discard] : [])], {timeout: 60000}),
    launch: (dir, model) =>
      run(
        'claude',
        ['--bg', ...(model ? ['--model', model] : []), ...(receiver ? ['--settings', launchSettings(s.port)] : [])],
        {cwd: dir, timeout: 120000},
      ),
    open: target => run('open', [target], {timeout: 15000}),
    saveState: r => void writer.save(r),
    tmux,
    ghosttyFocus: () => focusWorkbench(run),
    ghosttySplit: () =>
      splitWorkbench(run, `${shq(process.execPath)} ${shq(cliPath)} workbench`, {
        WHATNEXT_TMUX_SOCKET: s.socket,
        WHATNEXT_PORT: String(s.port),
      }),
    size: () => ({cols: process.stdout.columns || 80, rows: process.stdout.rows || 24}),
    write,
    exit: () => {
      receiver?.close();
      process.stdout.write(ALT_OFF);
      void writer.save(relations).finally(async () => {
        await tmux.killServer();
        process.exit(0);
      });
    },
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return {cancel: () => clearTimeout(t)};
    },
    home,
    startDir: env.WHATNEXT_START_DIR || process.cwd(),
  };

  app = new App(ports, {relations, version, leftovers});
  store.onEvent((sid, ev) => app.onHook(sid, ev));

  write(ALT_ON);
  const stdin = process.stdin;
  emitKeypressEvents(stdin, {escapeCodeTimeout: 30} as never);
  if (stdin.isTTY) stdin.setRawMode(true);
  let pasting: string | null = null;
  stdin.on('keypress', (str: string | undefined, key: Key | undefined) => {
    const k = key ?? {};
    if (k.name === 'paste-start') {
      pasting = '';
      return;
    }
    if (k.name === 'paste-end') {
      const text = pasting ?? '';
      pasting = null;
      app.paste(text);
      return;
    }
    if (pasting !== null) {
      pasting += str ?? '';
      return;
    }
    app.key(str, k);
  });
  stdin.resume();
  process.on('SIGWINCH', () => app.draw());
  process.stdout.on('resize', () => app.draw());
  process.on('SIGUSR2', () => void app.signal());
  process.on('SIGTERM', () => cleanupAndExit(143));
  process.on('SIGHUP', () => cleanupAndExit(129));
  process.on('SIGINT', () => {});
  process.on('uncaughtException', e => {
    try {
      process.stderr.write(`${e?.stack ?? e}\n`);
    } catch {}
    cleanupAndExit(1);
  });
  process.on('unhandledRejection', e => {
    try {
      process.stderr.write(`${(e as Error)?.stack ?? e}\n`);
    } catch {}
  });
  await app.start();
  void app.signal();
}
