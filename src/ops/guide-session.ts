import {GUIDE, type Tmux} from '../../lib/tmux/tmux.js';

// 作業台の画面の案内のセッション(DESIGN.md「作業台の画面の仕組み」)。一覧と `whatnext workbench` の両方が作る。

/**
 * 案内のセッションがなければ作る。作ったときは作業台の画面のオプションも入れる。名前(`@wn_name`)は一覧が入れる。
 * `command` は案内のプログラムを動かすコマンド(一覧と同じ版のもの)。
 */
export async function ensureGuide(tmux: Tmux, command: string, cwd: string): Promise<'exists' | 'created' | 'failed'> {
  if (await tmux.hasSession(GUIDE)) return 'exists';
  const r = await tmux.t(['new-session', '-d', '-s', GUIDE, '-c', cwd, command]);
  // 同時に作られたときは、相手が作ったものを使う
  if (r.code !== 0) return (await tmux.hasSession(GUIDE)) ? 'exists' : 'failed';
  await tmux.workbenchOptions(GUIDE, '');
  return 'created';
}
