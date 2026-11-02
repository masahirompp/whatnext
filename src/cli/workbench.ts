import {spawnSync} from 'node:child_process';
import {run} from '../../lib/input/exec.js';
import {GUIDE, LIST, Tmux} from '../../lib/tmux/tmux.js';
import {GUIDE_REFRESH, MAIN_TTY, WB_TTY} from '../ops/names.js';
import {type Env, myTty, tmuxEnv} from './env.js';
import {ensureGuide} from './guide.js';

// `whatnext workbench`(DESIGN.md「作業台の画面の仕組み」)。専用サーバの2つ目のクライアントとしてつなぐ。

export async function workbench(env: Env): Promise<number> {
  const tmux = new Tmux(env.socket, (cmd, args, opts) => run(cmd, args, {...opts, env: tmuxEnv(opts?.env)}));
  if (!(await tmux.hasSession(LIST))) {
    process.stderr.write('whatnext is not running. Start whatnext first.\n');
    return await fail();
  }
  const tty = myTty();
  if (tty) {
    await tmux.setOption(WB_TTY, tty);
    if ((await tmux.option(MAIN_TTY)) === tty) await tmux.unsetOption(MAIN_TTY);
  }
  // 案内のセッションは、一覧が動いている間に消えることがある(作り直しても直らなかったとき)。なければ作り直す
  const guide = await ensureGuide(tmux, env);
  if (guide === 'failed') {
    process.stderr.write(`whatnext: could not create the workbench guide (tmux session "${GUIDE}").\n`);
    return await fail();
  }
  if (guide === 'created') await askListToRefreshGuide(tmux);
  const res = spawnSync('tmux', ['-L', env.socket, 'attach-session', '-t', `=${GUIDE}`], {
    stdio: 'inherit',
    env: tmuxEnv(),
  });
  // tmux は、つなげなかったときと、whatnext の終了でサーバごと閉じたときに 0 以外で終わる。一覧が残っていれば前者
  if (res.error || (res.status !== 0 && (await tmux.hasSession(LIST)))) {
    process.stderr.write(`whatnext: could not open the workbench screen (tmux session "${GUIDE}").\n`);
    return await fail();
  }
  // tmux が主画面に残す `[detached ...]` の行を消す。古いタイトルの分割へ移らないよう、タイトルを消す
  process.stdout.write('\x1b[1A\x1b[2K\x1b]2;\x07');
  return 0;
}

/** 一覧に、案内のセッションの名前と中身を入れ直してもらう(作り直した案内には、一覧が入れた名前がない)。 */
async function askListToRefreshGuide(tmux: Tmux): Promise<void> {
  await tmux.setOption(`@wn_req_${Math.floor(Date.now() / 1000)}_${process.pid}`, GUIDE_REFRESH);
  const pid = Number(await tmux.option('@wn_pid'));
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGUSR2');
    } catch {}
  }
}

/**
 * Ghostty の分割から `exec` で起動したときは、終わると分割ごと閉じてエラーが読めない。キーを待ってから終わる。
 */
async function fail(): Promise<number> {
  if (process.env.WHATNEXT_WORKBENCH_SPLIT !== '1' || !process.stdin.isTTY) return 1;
  process.stderr.write('Press any key to close.');
  process.stdin.setRawMode(true);
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.setRawMode(false);
  process.stdin.pause();
  return 1;
}
