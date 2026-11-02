import {GUIDE, GUIDE_PANE, LIST, type Tmux} from '../../lib/tmux/tmux.js';

// 作業台の画面の案内のセッション(DESIGN.md「作業台の画面の仕組み」)。一覧と `whatnext workbench` の両方が作る。

/** 案内のプログラムが動く、最初のペイン。 */
const GUIDE_PANE_TARGET = `=${GUIDE}:0.0`;

/**
 * 案内のセッションがなければ作る。作ったときは作業台の画面のオプションと、案内のペインの印を入れる。名前(`@wn_name`)は一覧が入れる。
 * `command` は案内のプログラムを動かすコマンド(一覧と同じ版のもの)。一覧がないとき(終わったあと)は作らない
 * (`new-session` は、サーバがなければ設定のないサーバを立ち上げてしまう)。
 */
export async function ensureGuide(tmux: Tmux, command: string, cwd: string): Promise<'exists' | 'created' | 'failed'> {
  if (await tmux.hasSession(GUIDE)) return 'exists';
  if (!(await tmux.hasSession(LIST))) return 'failed';
  const r = await tmux.t(['new-session', '-d', '-s', GUIDE, '-c', cwd, command]);
  // 同時に作られたときは、相手が作ったものを使う
  if (r.code !== 0) return (await tmux.hasSession(GUIDE)) ? 'exists' : 'failed';
  await tmux.t(['set', '-p', '-t', GUIDE_PANE_TARGET, GUIDE_PANE, '1']);
  await tmux.workbenchOptions(GUIDE, '');
  return 'created';
}

/**
 * 一覧の起動時に、前からある案内のセッションを使えるようにする。印のない前の版の案内に印を入れ、
 * 起動し直しをやめて死んだまま残した案内のペインは、数え直して起動し直す。
 */
export async function reviveGuide(tmux: Tmux): Promise<void> {
  await tmux.t(['set', '-p', '-t', GUIDE_PANE_TARGET, GUIDE_PANE, '1']);
  const dead = await tmux.t(['display', '-p', '-t', GUIDE_PANE_TARGET, '#{pane_dead}']);
  if (dead.stdout.trim() !== '1') return;
  await tmux.t(['set', '-pu', '-t', GUIDE_PANE_TARGET, '@wn_respawned']);
  await tmux.t(['respawn-pane', '-t', GUIDE_PANE_TARGET]);
}
