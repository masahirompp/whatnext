import {spawnSync} from 'node:child_process';
import {run} from '../../lib/input/exec.js';
import {probe} from '../../lib/input/receiver.js';
import {LIST, Tmux} from '../../lib/tmux/tmux.js';
import {type Env, myTty, paneCommand, tmuxEnv} from './env.js';

// `whatnext` の起動(DESIGN.md「一覧と作業台の仕組み」)。専用の tmux サーバの `list` につなぐ。なければ作る。

import {DIGEST_ON, LEGACY_DIGEST_WANTED, MAIN_TTY, NEWER, WB_TTY} from '../ops/names.js';

const tmuxRun: typeof run = (cmd, args, opts) => run(cmd, args, {...opts, env: tmuxEnv(opts?.env ?? process.env)});

/** `tmux -V` の出力(`tmux 3.7c` など)。tmux がなければ undefined。 */
export async function tmuxVersion(): Promise<string | undefined> {
  const r = await run('tmux', ['-V'], {timeout: 5000});
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/**
 * 動いている一覧が、ダイジェストを有効にして動いているか。一覧のセッションのオプション `@wn_digest` の `1` か `0` を読む。
 * 起動の口が、セッションを作る呼び出しの中で置く(一覧も起動の最初に同じ値を置く)ので、今の版の一覧に値のない間はない。
 * 値がないのは 0.24 までの一覧で、0.24 は `--digest` のときだけサーバ全体のオプションに `1` を置いたので、そちらを読む
 * (0.23 までの一覧にはどちらもなく、ダイジェストもない)。
 */
async function listHasDigests(tmux: Tmux): Promise<boolean> {
  const r = await tmux.t(['show-options', '-t', `=${LIST}:`, '-qv', DIGEST_ON]);
  const own = r.code === 0 ? r.stdout.trim() : '';
  if (own) return own === '1';
  return (await tmux.option(DIGEST_ON)) === '1';
}

export async function launch(env: Env): Promise<number> {
  const tmux = new Tmux(env.socket, tmuxRun);
  const tty = myTty();
  if (await tmux.hasSession(LIST)) {
    // 明示した --no-digest が効かない一覧には、つながずに断る(黙ってつなぐと、切ったつもりのセッションが Haiku を呼ぶ)。
    // 何も変えずに終わるので、サーバのオプションに触れる前に確かめる
    if (!env.digest && (await listHasDigests(tmux))) {
      process.stderr.write(
        'whatnext: a whatnext with digests is already running. Quit it first (run whatnext, then press q), then run whatnext --no-digest.\n',
      );
      return 1;
    }
    const running = await tmux.option('@wn_version');
    if (running && running !== env.version) await tmux.setOption(NEWER, env.version);
    else await tmux.unsetOption(NEWER);
    // 逆向き(--no-digest の一覧に引数なしでつなぐ)は、何も示さずにつなぐ(PRODUCT.md「ダイジェスト」)
    // 移行のため: 0.24 の `whatnext --digest` が置いた知らせの印を外す。0.24 の一覧が動いたままだと、消した `--digest` を
    // 打てという知らせ(whatnext is running without --digest. ...)が残る。0.24 の起動の口も、つなぐたびに外していた
    await tmux.unsetOption(LEGACY_DIGEST_WANTED);
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
      // 「この一覧はダイジェストが有効か」を、セッションを作るのと同じ呼び出しで置く(`listHasDigests` が読む)。一覧のプロセスが
      // 起動してから置くと、それまでの間に実行された `whatnext --no-digest` が、値のないセッションを見る
      ';',
      'set',
      '-t',
      `=${LIST}:`,
      DIGEST_ON,
      env.digest ? '1' : '0',
      // サーバ全体に残った 0.24 の値を外す(0.24 の --digest の一覧が異常終了し、作業台のためにサーバが残ったとき)。
      // ここに来るのは一覧のセッションがないときなので、値を置いた一覧はもう動いていない
      ';',
      'set',
      '-gqu',
      DIGEST_ON,
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
  // 終了の操作でサーバごと閉じたときも、tmux は 0 以外で終わる。attach できなかったときだけ失敗にする
  return res.error ? 1 : 0;
}
