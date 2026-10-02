// Ghostty(1.3 の AppleScript)で、作業台の画面の分割を作る・そこへ移る(ctrl+q ctrl+w)。
// 作業台の画面は端末のタイトルで見分ける。作業台のセッションだけ set-titles を on にして、この文字列を出す(tmux.ts)
import {execFile} from 'node:child_process';
import {CLI, PORT, SOCKET} from './env.js';
import {WB_TITLE, tmux} from './tmux.js';

const SCRIPT = `on run argv
	set mode to item 1 of argv
	set wbTitle to item 2 of argv
	tell application "Ghostty"
		if mode is "focus" then
			repeat with w in windows
				repeat with t in tabs of w
					repeat with x in terminals of t
						if name of x is wbTitle then
							focus x
							return "focused"
						end if
					end repeat
				end repeat
			end repeat
			return "notfound"
		end if
		if not frontmost then return "notfront"
		set src to focused terminal of selected tab of front window
		set cfg to new surface configuration
		set initial input of cfg to item 3 of argv
		set environment variables of cfg to items 4 thru -1 of argv
		split src direction right with configuration cfg
		return "split"
	end tell
end run`;

const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function osa(args: string[]): Promise<string> {
	return new Promise(resolve => {
		execFile('osascript', ['-e', SCRIPT, ...args], {timeout: 5000}, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
	});
}

export async function onGhostty(tty: string): Promise<boolean> {
	const r = await tmux('display', '-p', '-c', tty, '#{client_termname}');
	return r.ok && r.out.includes('ghostty');
}

// 作業台の画面があればその分割へ移り、なければ、押した端末(Ghostty の前面の分割)を右に分割して開く。
// 開けたら true。Ghostty でない、前面にない、許可がないなどのときは false で、呼んだ側が今までどおり案内を出す
export async function showWorkbenchSplit(tty: string, open: boolean): Promise<boolean> {
	if (process.platform !== 'darwin' || !(await onGhostty(tty))) return false;
	if (open) return (await osa(['focus', WB_TITLE])) === 'focused';
	// command で渡すと、Ghostty はコマンドが終わっても分割を残し、キーを押すまで閉じない(wait after command を false にしても)。
	// いつものシェルで開いて exec し、作業台の画面が終わればシェルごと終わって分割が閉じるようにする。先頭の空白で履歴に残さない
	const cmd = ` exec ${sh(process.execPath)} ${sh(CLI)} workbench\n`;
	const env = [`WHATNEXT_TMUX_SOCKET=${SOCKET}`, `WHATNEXT_PORT=${PORT}`];
	return (await osa(['split', WB_TITLE, cmd, ...env])) === 'split';
}
