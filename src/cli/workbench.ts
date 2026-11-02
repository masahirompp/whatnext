import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {run} from '../../lib/input/exec.js';
import {GUIDE, LIST, Tmux} from '../../lib/tmux/tmux.js';
import {ensureGuide} from '../ops/guide-session.js';
import {MAIN_TTY, WB_TTY} from '../ops/names.js';
import {type Env, myTty, paneCommand, tmuxEnv} from './env.js';

// `whatnext workbench`(DESIGN.md「作業台の画面の仕組み」)。専用サーバの2つ目のクライアントとしてつなぐ。

export async function workbench(env: Env): Promise<number> {
  const tmux = new Tmux(env.socket, (cmd, args, opts) => run(cmd, args, {...opts, env: tmuxEnv(opts?.env)}));
  if (!(await tmux.hasSession(LIST))) {
    process.stderr.write('whatnext is not running. Start whatnext first.\n');
    return await exitWithError();
  }
  const tty = myTty();
  if (tty) {
    await tmux.setOption(WB_TTY, tty);
    if ((await tmux.option(MAIN_TTY)) === tty) await tmux.unsetOption(MAIN_TTY);
  }
  if (!(await waitForGuide(tmux, env))) {
    process.stderr.write(`whatnext: could not create the workbench guide (tmux session "${GUIDE}").\n`);
    return await exitWithError();
  }
  const res = spawnSync('tmux', ['-L', env.socket, 'attach-session', '-t', `=${GUIDE}`], {
    stdio: 'inherit',
    env: tmuxEnv(),
  });
  // tmux は、つなげなかったときと、whatnext の終了でサーバごと閉じたときに 1 で終わる。一覧が残っていれば前者。
  // シグナルで終わったとき(status が null)は、つながったあとに止められたので、失敗にしない
  if (res.error || (res.status !== null && res.status !== 0 && (await tmux.hasSession(LIST)))) {
    process.stderr.write(`whatnext: could not open the workbench screen (tmux session "${GUIDE}").\n`);
    return await exitWithError();
  }
  // tmux が主画面に残す `[detached ...]` の行を消す。古いタイトルの分割へ移らないよう、タイトルを消す
  process.stdout.write('\x1b[1A\x1b[2K\x1b]2;\x07');
  return 0;
}

/**
 * 案内のセッションがなければ、一覧に知らせて一覧の版で作り直させる(一覧は知らせのたびに確かめる)。
 * 一覧が作らないとき(案内を作り直さない古い版の一覧)は、自分で作る。
 */
async function waitForGuide(tmux: Tmux, env: Env): Promise<boolean> {
  if (await tmux.hasSession(GUIDE)) return true;
  const pid = Number(await tmux.option('@wn_pid'));
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGUSR2');
    } catch {}
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (await tmux.hasSession(GUIDE)) return true;
    }
  }
  return (await ensureGuide(tmux, paneCommand(env, 'guide'), homedir())) !== 'failed';
}

/**
 * 失敗して終わる。Ghostty の分割から `exec` で起動したとき(`WHATNEXT_WORKBENCH_SPLIT=1`)は、
 * 終わると分割ごと閉じてエラーが読めないので、キーを待ってから終わる。
 */
async function exitWithError(): Promise<number> {
  if (process.env.WHATNEXT_WORKBENCH_SPLIT !== '1' || !process.stdin.isTTY) return 1;
  process.stderr.write('Press any key to close.');
  process.stdin.setRawMode(true);
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.setRawMode(false);
  process.stdin.pause();
  return 1;
}
