import {GUIDE, GUIDE_PANE, GUIDE_RESPAWNED, LIST, type Tmux} from '../../lib/tmux/tmux.js';

// 作業台の画面の案内のセッション(DESIGN.md「作業台の画面の仕組み」)。一覧と `whatnext workbench` の両方が作る。
// 案内のプログラムのペインは、印 GUIDE_PANE で見分ける(lib の契約)。セッションがあっても、印のあるペインがあるとは限らない
// (利用者が案内のセッションで分割し、案内のペインを閉じたときなど)。利用者のペインは止めない。

type GuidePanes = {session: false} | {session: true; guide?: string; deadOthers: string[]};

/** 案内のセッションのペイン。`guide` は印のあるペインの ID、`deadOthers` は死んだまま残った印のないペインの ID。 */
async function guidePanes(tmux: Tmux): Promise<GuidePanes> {
  const r = await tmux.t(['list-panes', '-s', '-t', `=${GUIDE}`, '-F', `#{pane_id} #{pane_dead} #{${GUIDE_PANE}}`]);
  if (r.code !== 0) return {session: false};
  let guide: string | undefined;
  const deadOthers: string[] = [];
  for (const line of r.stdout.split('\n')) {
    const [id, dead, mark] = line.split(' ');
    if (!id) continue;
    if (mark === '1') guide ??= id;
    else if (dead === '1') deadOthers.push(id);
  }
  return {session: true, guide, deadOthers};
}

/** 案内のプログラムのペインがあるか(死んだまま残したものを含む)。 */
export async function hasGuide(tmux: Tmux): Promise<boolean> {
  const p = await guidePanes(tmux);
  return p.session && !!p.guide;
}

/**
 * 案内のプログラムを動かす tmux のコマンド(`new-session` か `new-window`)に、印を付ける `set -p` を続ける。
 * 印は同じ1回の tmux で付ける(分けると、すぐ終わる案内が印の付く前に `pane-died` で閉じられる)。
 */
const withGuideMark = (create: string[]): string[] => [
  ...create,
  ';',
  ...['set', '-p', '-t', `=${GUIDE}:`, GUIDE_PANE, '1'],
];

/** 案内のプログラムのペインがあるときに、死んだまま残った印のないペイン(利用者が分割したもの)を片付ける。 */
async function clearDeadOthers(tmux: Tmux, deadOthers: string[]): Promise<void> {
  for (const id of deadOthers) await tmux.t(['kill-pane', '-t', id]);
}

/**
 * 案内のプログラムのペインがなければ作る。`command` は案内のプログラムを動かすコマンド(一覧と同じ版のもの)。
 * - セッションがなければ作り、作業台の画面のオプションを入れる。一覧がないとき(終わったあと)は作らない
 *   (`new-session` は、サーバがなければ設定のないサーバを立ち上げてしまう)
 * - セッションはあるが印のあるペインがなければ、新しいウィンドウで案内を動かす
 * 起動し直しをやめて死んだまま残した案内のペインは、あるものとして扱う。死んだまま残った印のないペインは片付ける。
 * 名前(`@wn_name`)は一覧が入れる。
 */
export async function ensureGuide(tmux: Tmux, command: string, cwd: string): Promise<'exists' | 'created' | 'failed'> {
  const panes = await guidePanes(tmux);
  if (panes.session) {
    if (!panes.guide) {
      // 新しいウィンドウで案内を動かし、映すウィンドウをそこへ移す。利用者のペインは止めない
      const w = await tmux.t(withGuideMark(['new-window', '-t', `=${GUIDE}:`, '-c', cwd, command]));
      // 作れなかったときは片付けない(最後のペインを閉じると、案内のセッションが消える)
      if (w.code !== 0) return 'failed';
    }
    await clearDeadOthers(tmux, panes.deadOthers);
    return panes.guide ? 'exists' : 'created';
  }
  if (!(await tmux.hasSession(LIST))) return 'failed';
  const r = await tmux.t(withGuideMark(['new-session', '-d', '-s', GUIDE, '-c', cwd, command]));
  // 同時に作られたときは、相手が作ったものを使う
  if (r.code !== 0) return (await hasGuide(tmux)) ? 'exists' : 'failed';
  await tmux.workbenchOptions(GUIDE, '');
  return 'created';
}

/**
 * 一覧の起動時に、案内を一覧の版で動かし直す。前からある案内のセッション(異常終了のあと)の案内は、前の版のまま動いていたり、
 * 起動し直しをやめて死んだまま残っていたりするため。印のない前の版の案内のセッションには、新しいウィンドウで案内を足す。
 */
export async function startGuide(tmux: Tmux, command: string, cwd: string): Promise<void> {
  const panes = await guidePanes(tmux);
  if (!panes.session || !panes.guide) {
    await ensureGuide(tmux, command, cwd);
  } else {
    await tmux.t([
      ...['respawn-pane', '-k', '-t', panes.guide, command, ';'],
      ...['set', '-pu', '-t', panes.guide, GUIDE_RESPAWNED],
    ]);
    await clearDeadOthers(tmux, panes.deadOthers);
  }
  // 前の版の案内のセッションにも、今の版のオプションを入れ直す
  if (panes.session) await tmux.workbenchOptions(GUIDE, '');
}
