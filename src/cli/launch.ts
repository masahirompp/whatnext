import {spawnSync} from 'node:child_process';
import {run} from '../../lib/input/exec.js';
import {probe} from '../../lib/input/receiver.js';
import {LIST, Tmux} from '../../lib/tmux/tmux.js';
import {type Env, myTty, paneCommand, tmuxEnv} from './env.js';

// `whatnext` の起動(DESIGN.md「一覧と作業台の仕組み」)。専用の tmux サーバの `list` につなぐ。なければ作る。

export const MAIN_TTY = '@wn_main_tty';
export const WB_TTY = '@wn_wb_tty';
export const NEWER = '@wn_newer';

const tmuxRun: typeof run = (cmd, args, opts) => run(cmd, args, {...opts, env: tmuxEnv(opts?.env ?? process.env)});

export async function hasTmux(): Promise<boolean> {
  const r = await run('tmux', ['-V'], {timeout: 5000});
  return r.code === 0;
}

export async function launch(env: Env): Promise<number> {
  const tmux = new Tmux(env.socket, tmuxRun);
  const tty = myTty();
  if (await tmux.hasSession(LIST)) {
    const running = await tmux.option('@wn_version');
    if (running && running !== env.version) await tmux.setOption(NEWER, env.version);
    else await tmux.unsetOption(NEWER);
  } else {
    if ((await probe(env.port)) === 'whatnext') {
      process.stderr.write(
        `whatnext: another whatnext is using 127.0.0.1:${env.port}. Quit it first, then run whatnext again.\n`,
      );
      return 1;
    }
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    const cmd = paneCommand(env, 'list');
    const server = (await tmux.sessions()).length > 0;
    const args = [
      ...(server ? [] : ['-f', '/dev/null']),
      'new-session',
      '-d',
      '-s',
      LIST,
      '-x',
      String(cols),
      '-y',
      String(rows),
      '-c',
      process.cwd(),
      cmd,
      ';',
      'set',
      '-s',
      'terminal-features[90]',
      'xterm*:RGB:hyperlinks',
      ';',
      'set',
      '-s',
      'terminal-features[91]',
      'ghostty*:RGB:hyperlinks',
    ];
    const r = await tmuxRun('tmux', ['-L', env.socket, ...args]);
    if (r.code !== 0) {
      process.stderr.write(`whatnext: could not start tmux: ${(r.stderr || r.stdout).trim()}\n`);
      return 1;
    }
  }
  if (tty) {
    await tmux.setOption(MAIN_TTY, tty);
    if ((await tmux.option(WB_TTY)) === tty) await tmux.unsetOption(WB_TTY);
  }
  const res = spawnSync('tmux', ['-L', env.socket, 'attach-session', '-t', `=${LIST}`], {
    stdio: 'inherit',
    env: tmuxEnv(),
  });
  // tmux が主画面に残す `[detached ...]` の行を消す
  process.stdout.write('\x1b[1A\x1b[2K');
  return res.status ?? 0;
}
