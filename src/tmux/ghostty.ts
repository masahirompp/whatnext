// tmux: Ghostty で押した `ctrl+q ctrl+w` と一覧の `w` で、作業台の画面の分割を作る、またはそこへ移る(ADR-0015)。

import type {Run} from '../input/exec.js';

const FOCUS = `on run argv
  tell application "Ghostty"
    repeat with t in terminals
      if name of t is "whatnext workbench" then
        focus t
        return "focused"
      end if
    end repeat
  end tell
  return "none"
end run`;

const SPLIT = `on run argv
  tell application "Ghostty"
    if not frontmost then return "notfront"
    set cfg to new surface configuration
    set initial input of cfg to (item 1 of argv)
    set environment variables of cfg to rest of argv
    set ft to focused terminal of selected tab of front window
    set nt to split ft direction right with configuration cfg
    focus nt
  end tell
  return "split"
end run`;

export type GhosttyResult = 'focused' | 'split' | 'none' | 'notfront' | 'failed';

/** 名前が `whatnext workbench` の分割へフォーカスを移す。 */
export async function focusWorkbench(run: Run): Promise<GhosttyResult> {
  const r = await run('osascript', ['-e', FOCUS], {timeout: 10000});
  if (r.code !== 0) return 'failed';
  return r.stdout.trim() === 'focused' ? 'focused' : 'none';
}

/** 押した分割を右に分割し、`whatnext workbench` を打ち込む。 */
export async function splitWorkbench(run: Run, command: string, env: Record<string, string>): Promise<GhosttyResult> {
  const args = ['-e', SPLIT, ` exec ${command}\n`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  const r = await run('osascript', args, {timeout: 10000});
  if (r.code !== 0) return 'failed';
  const out = r.stdout.trim();
  return out === 'split' ? 'split' : out === 'notfront' ? 'notfront' : 'failed';
}
