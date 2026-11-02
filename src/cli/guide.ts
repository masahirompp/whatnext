import {homedir} from 'node:os';
import {emitKeypressEvents} from 'node:readline';
import {run} from '../../lib/input/exec.js';
import {color, truncate} from '../../lib/text/text.js';
import {GUIDE, Tmux} from '../../lib/tmux/tmux.js';
import {GUIDE_CREATE} from '../ops/keys.js';
import {GUIDE_OPTION, type GuideState} from '../ops/names.js';
import {clean, frame} from '../screen/screen.js';
import {type Env, paneCommand, tmuxEnv} from './env.js';

// 作業台の画面の案内(案内のセッションの中で動く)。何を出すかは一覧が `@wn_guide` に置く。

/**
 * 案内のセッションがなければ作る(一覧の起動時と、`whatnext workbench` の attach の前)。
 * 作ったときは作業台の画面のオプションも入れる。名前(`@wn_name`)は一覧が入れ直す。
 */
export async function ensureGuide(tmux: Tmux, env: Env): Promise<'exists' | 'created' | 'failed'> {
  if (await tmux.hasSession(GUIDE)) return 'exists';
  const r = await tmux.t(['new-session', '-d', '-s', GUIDE, '-c', homedir(), paneCommand(env, 'guide')]);
  // 同時に作られたときは、相手が作ったものを使う
  if (r.code !== 0) return (await tmux.hasSession(GUIDE)) ? 'exists' : 'failed';
  await tmux.workbenchOptions(GUIDE, '');
  return 'created';
}

export function guideLines(g: GuideState): string[] {
  if (g.kind === 'tty') return [`${clean(g.name)} is an interactive session. It has no workbench.`];
  if (g.kind === 'empty') return ['No session is selected in the list.'];
  const lines = [`No workbench for ${clean(g.name)} yet.`, `Enter: open a shell in ${clean(g.path)}`];
  return g.closed ? ['Workbench closed.', ...lines] : lines;
}

export function parseGuide(text: string | undefined): GuideState {
  try {
    const j = JSON.parse(text ?? '') as GuideState;
    if (j && (j.kind === 'none' || j.kind === 'tty' || j.kind === 'empty')) return j;
  } catch {}
  return {kind: 'empty'};
}

export async function guide(env: Env): Promise<number> {
  const tmux = new Tmux(env.socket, (cmd, args, opts) => run(cmd, args, {...opts, env: tmuxEnv(opts?.env)}));
  let state: GuideState = {kind: 'empty'};
  let raw = '';
  const draw = () => {
    const w = process.stdout.columns || 80;
    const lines = guideLines(state).map(l => truncate(l, w));
    const body = lines.map((l, i) => (i === lines.length - 1 && state.kind === 'none' ? color.bold(l) : l));
    process.stdout.write(frame(body));
  };
  const reload = async () => {
    const t = (await tmux.option(GUIDE_OPTION)) ?? '';
    if (t === raw) return;
    raw = t;
    state = parseGuide(t);
    draw();
  };
  process.stdout.write('\x1b[?25l');
  process.on('SIGUSR1', () => void reload());
  process.on('SIGUSR2', () => void reload());
  process.stdout.on('resize', draw);
  setInterval(() => void reload(), 300);
  let lastEnter = 0;
  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin, {escapeCodeTimeout: 30} as never);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', (_s: string, key: {name?: string}) => {
      if (key?.name !== 'return' && key?.name !== 'enter') return;
      if (state.kind !== 'none') return;
      const now = Date.now();
      if (now - lastEnter < 1100) return;
      lastEnter = now;
      void (async () => {
        await tmux.setOption(`@wn_req_${Math.floor(now / 1000)}_${process.pid}`, `key ${GUIDE_CREATE} wbguide -`);
        const pid = Number(await tmux.option('@wn_pid'));
        if (pid > 0) {
          try {
            process.kill(pid, 'SIGUSR2');
          } catch {}
        }
      })();
    });
  }
  await reload();
  draw();
  return await new Promise<number>(() => {});
}
