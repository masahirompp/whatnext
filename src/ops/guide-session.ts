import {GUIDE, GUIDE_PANE, LIST, type Tmux} from '../../lib/tmux/tmux.js';

// 作業台の画面の案内のセッション(DESIGN.md「作業台の画面の仕組み」)。一覧と `whatnext workbench` の両方が作る。
// 案内のプログラムのペインは、印 GUIDE_PANE で見分ける(lib の契約)。セッションがあっても、印のあるペインがあるとは限らない
// (利用者が案内のセッションで分割し、案内のペインを閉じたときなど)。

/** 案内のセッションの、印のあるペインの ID。セッションがなければ undefined、印のあるペインがなければ null。 */
async function guidePane(tmux: Tmux): Promise<string | null | undefined> {
  const r = await tmux.t(['list-panes', '-s', '-t', `=${GUIDE}`, '-F', `#{pane_id} #{${GUIDE_PANE}}`]);
  if (r.code !== 0) return undefined;
  for (const line of r.stdout.split('\n')) {
    const [id, mark] = line.split(' ');
    if (id && mark === '1') return id;
  }
  return null;
}

/** 案内のプログラムのペインがあるか(死んだまま残したものを含む)。 */
export async function hasGuide(tmux: Tmux): Promise<boolean> {
  return !!(await guidePane(tmux));
}

/** 案内のプログラムを `target` のペインで動かし直し、印を付けて数え直させる(1回の tmux で送り、印を付ける前に終わるのを避ける)。 */
async function respawnGuide(tmux: Tmux, target: string, command: string): Promise<boolean> {
  const r = await tmux.t([
    ...['respawn-pane', '-k', '-t', target, command, ';'],
    ...['set', '-p', '-t', target, GUIDE_PANE, '1', ';'],
    ...['set', '-pu', '-t', target, '@wn_respawned'],
  ]);
  return r.code === 0;
}

/**
 * 案内のプログラムのペインがなければ作る。`command` は案内のプログラムを動かすコマンド(一覧と同じ版のもの)。
 * - セッションがなければ作り、作業台の画面のオプションを入れる。一覧がないとき(終わったあと)は作らない
 *   (`new-session` は、サーバがなければ設定のないサーバを立ち上げてしまう)
 * - セッションはあるが印のあるペインがなければ、いま映っているペインで案内を動かし直す
 * 起動し直しをやめて死んだまま残した案内のペインは、あるものとして扱う。名前(`@wn_name`)は一覧が入れる。
 */
export async function ensureGuide(tmux: Tmux, command: string, cwd: string): Promise<'exists' | 'created' | 'failed'> {
  const pane = await guidePane(tmux);
  if (pane) return 'exists';
  if (pane === null) return (await respawnGuide(tmux, `=${GUIDE}:`, command)) ? 'created' : 'failed';
  if (!(await tmux.hasSession(LIST))) return 'failed';
  const r = await tmux.t([
    ...['new-session', '-d', '-s', GUIDE, '-c', cwd, command, ';'],
    ...['set', '-p', '-t', `=${GUIDE}:`, GUIDE_PANE, '1'],
  ]);
  // 同時に作られたときは、相手が作ったものを使う
  if (r.code !== 0) return (await guidePane(tmux)) ? 'exists' : 'failed';
  await tmux.workbenchOptions(GUIDE, '');
  return 'created';
}

/**
 * 一覧の起動時に、案内を一覧の版で動かし直す。前からある案内のセッション(異常終了のあと)の案内は、前の版のまま動いていたり、
 * 起動し直しをやめて死んだまま残っていたり、印のない前の版のものだったりするため。
 */
export async function startGuide(tmux: Tmux, command: string, cwd: string): Promise<void> {
  const pane = await guidePane(tmux);
  if (pane === undefined) {
    await ensureGuide(tmux, command, cwd);
    return;
  }
  await respawnGuide(tmux, pane ?? `=${GUIDE}:`, command);
  // 前の版の案内のセッションにも、今の版のオプションを入れ直す
  await tmux.workbenchOptions(GUIDE, '');
}
