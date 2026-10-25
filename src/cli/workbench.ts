import {spawnSync} from 'node:child_process';
import {run} from '../../lib/input/exec.js';
import {GUIDE, LIST, Tmux} from '../../lib/tmux/tmux.js';
import {MAIN_TTY, WB_TTY} from '../ops/names.js';
import {type Env, myTty, tmuxEnv} from './env.js';

// `whatnext workbench`(DESIGN.md「作業台の画面の仕組み」)。専用サーバの2つ目のクライアントとしてつなぐ。

export async function workbench(env: Env): Promise<number> {
  const tmux = new Tmux(env.socket, (cmd, args, opts) => run(cmd, args, {...opts, env: tmuxEnv(opts?.env)}));
  if (!(await tmux.hasSession(LIST))) {
    process.stderr.write('whatnext is not running. Start whatnext first.\n');
    return 1;
  }
  const tty = myTty();
  if (tty) {
    await tmux.setOption(WB_TTY, tty);
    if ((await tmux.option(MAIN_TTY)) === tty) await tmux.unsetOption(MAIN_TTY);
  }
  const res = spawnSync('tmux', ['-L', env.socket, 'attach-session', '-t', `=${GUIDE}`], {
    stdio: 'inherit',
    env: tmuxEnv(),
  });
  // 古いタイトルの分割へ移らないよう、タイトルを消す
  process.stdout.write('\x1b[1A\x1b[2K\x1b]2;\x07');
  return res.status ?? 0;
}
