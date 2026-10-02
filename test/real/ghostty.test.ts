// 実機の通し: Ghostty の分割(シナリオ 58a)。前面に新しい Ghostty のウィンドウを開いて操作し、終わったら閉じる。
// 作業台の画面の分割を作るのは whatnext で、テストは AppleScript でキーを送り、分割の数と名前を読む。

import {execFileSync, spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {cleanupSessions, RealHarness, ROOT, sleep, WORKDIR, waitState} from './harness.js';

let h: RealHarness;
let windowId = '';

const osa = (script: string, ...args: string[]): string =>
  execFileSync('osascript', ['-e', script, ...args], {encoding: 'utf8'}).trim();

function openWindow(command: string, withShellSplit: boolean): string {
  return osa(
    `on run argv
  tell application "Ghostty"
    activate
    set cfg to new surface configuration
    set initial input of cfg to (item 1 of argv)
    set w to new window with configuration cfg
    delay 1
    if (item 2 of argv) is "split" then
      set firstTerm to focused terminal of selected tab of w
      split firstTerm direction right
      delay 1
      focus firstTerm
    end if
    return id of w
  end tell
end run`,
    `${command}\n`,
    withShellSplit ? 'split' : 'nosplit',
  );
}

const inWindow = (body: string) =>
  osa(
    `on run argv
  tell application "Ghostty"
    set w to first window whose id is (item 1 of argv)
    ${body}
  end tell
end run`,
    windowId,
  );

const terminalNames = (): string[] =>
  inWindow(
    'set out to {}\nrepeat with t in terminals of selected tab of w\nset end of out to name of t\nend repeat\nset AppleScript\'s text item delimiters to "|"\nreturn out as text',
  ).split('|');

const focusedName = () => inWindow('return name of focused terminal of selected tab of w');

/** 左端の分割(whatnext)にフォーカスを戻してキーを送る。 */
function sendToLeft(...keys: [string, string][]): void {
  // 修飾キーのない1文字は send key では届かないので input text で送る。
  const lines = keys
    .map(([k, m]) =>
      !m && k.length === 1 ? `input text "${k}" to t` : `send key "${k}"${m ? ` modifiers "${m}"` : ''} to t`,
    )
    .join('\ndelay 0.2\n');
  inWindow(`set t to terminal 1 of selected tab of w\nfocus t\ndelay 0.3\n${lines}`);
}

beforeAll(async () => {
  cleanupSessions();
  await new RealHarness().ensureTrusted();
});

afterEach(() => {
  if (windowId) {
    try {
      inWindow('close window w');
    } catch {}
    windowId = '';
  }
  if (process.env.WN_KEEP_LOG) console.log(h?.debugLog());
  h?.cleanup();
});

describe('Ghostty の分割', () => {
  it('58a: ctrl+q ctrl+w で作業台の画面の分割が右にでき、もう一度押すと移るだけ。ふだんのシェルの分割には入力しない。終了で閉じる', async () => {
    h = new RealHarness();
    const name = `wn-real-gh-${Date.now().toString(36)}`;
    const out = execFileSync('claude', ['--bg', '--name', name], {cwd: WORKDIR, encoding: 'utf8'});
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 色を除く
    const id = /backgrounded\s*·\s*([^\s·]+)/.exec(out.replace(/\x1b\[[0-9;]*m/g, ''))?.[1] as string;
    await waitState(id, r => r.pid !== undefined);
    const env = Object.entries(h.env())
      .filter(([k]) => k.startsWith('WHATNEXT_') || k === 'XDG_STATE_HOME')
      .map(([k, v]) => `${k}='${v}'`)
      .join(' ');
    windowId = openWindow(` cd ${WORKDIR} && env ${env} node ${join(ROOT, 'dist', 'cli.js')}`, true);
    expect(terminalNames()).toHaveLength(2);
    // 一覧が出るまで待ち、自分のセッションの行を選んで attach する
    for (let i = 0; i < 60 && !h.tmux('capture-pane', '-p', '-t', '=list:').includes(name); i++) await sleep(500);
    for (let i = 0; i < 40 && !/^> .*wn-real-gh/m.test(h.tmux('capture-pane', '-p', '-t', '=list:')); i++) {
      h.tmux('send-keys', '-t', '=list:', 'Down');
      await sleep(200);
    }
    h.tmux('send-keys', '-t', '=list:', 'Enter');
    for (let i = 0; i < 40 && !h.tmux('list-clients', '-F', '#{client_session}').includes(id); i++) await sleep(500);
    await sleep(2000);
    // ctrl+q ctrl+w: 作業台を作り、右に分割して作業台の画面を開き、フォーカスを移す
    sendToLeft(['q', 'control'], ['w', 'control']);
    for (let i = 0; i < 40 && terminalNames().length < 3; i++) await sleep(500);
    for (let i = 0; i < 40 && !terminalNames().includes('whatnext workbench'); i++) await sleep(500);
    expect(terminalNames()).toHaveLength(3);
    expect(focusedName()).toBe('whatnext workbench');
    expect(h.sessions()).toContain(`sh-${id}`);
    // 左に戻ってもう一度押すと、分割は増えずにフォーカスが移るだけ
    sendToLeft(['q', 'control'], ['w', 'control']);
    await sleep(2500);
    expect(terminalNames()).toHaveLength(3);
    expect(focusedName()).toBe('whatnext workbench');
    // 一覧の w でも同じ(すでに開いているので移るだけ)
    sendToLeft(['q', 'control'], ['l', 'control']);
    await sleep(1500);
    h.tmux('send-keys', '-t', '=list:', 'w');
    await sleep(2500);
    expect(terminalNames()).toHaveLength(3);
    expect(focusedName()).toBe('whatnext workbench');
    // 終了すると、whatnext が作った分割は閉じる
    h.tmux('send-keys', '-t', '=list:', 'q');
    for (let i = 0; i < 30 && terminalNames().length > 2; i++) await sleep(500);
    expect(terminalNames()).toHaveLength(2);
    spawnSync('claude', ['rm', id]);
  });

  it('58a: 一覧の w でも、作業台の画面がなければ一覧の分割の右に開く', async () => {
    h = new RealHarness();
    const name = `wn-real-gw-${Date.now().toString(36)}`;
    const out = execFileSync('claude', ['--bg', '--name', name], {cwd: WORKDIR, encoding: 'utf8'});
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 色を除く
    const id = /backgrounded\s*·\s*([^\s·]+)/.exec(out.replace(/\x1b\[[0-9;]*m/g, ''))?.[1] as string;
    await waitState(id, r => r.pid !== undefined);
    const env = Object.entries(h.env())
      .filter(([k]) => k.startsWith('WHATNEXT_') || k === 'XDG_STATE_HOME')
      .map(([k, v]) => `${k}='${v}'`)
      .join(' ');
    windowId = openWindow(` cd ${WORKDIR} && env ${env} node ${join(ROOT, 'dist', 'cli.js')}`, false);
    for (let i = 0; i < 60 && !h.tmux('capture-pane', '-p', '-t', '=list:').includes(name); i++) await sleep(500);
    for (let i = 0; i < 40 && !/^> .*wn-real-gw/m.test(h.tmux('capture-pane', '-p', '-t', '=list:')); i++) {
      h.tmux('send-keys', '-t', '=list:', 'Down');
      await sleep(200);
    }
    h.tmux('send-keys', '-t', '=list:', 'w');
    for (let i = 0; i < 40 && terminalNames().length < 2; i++) await sleep(500);
    for (let i = 0; i < 40 && !terminalNames().includes('whatnext workbench'); i++) await sleep(500);
    expect(terminalNames()).toHaveLength(2);
    expect(focusedName()).toBe('whatnext workbench');
    h.tmux('send-keys', '-t', '=list:', 'q');
    for (let i = 0; i < 30 && terminalNames().length > 1; i++) await sleep(500);
    expect(terminalNames()).toHaveLength(1);
    spawnSync('claude', ['rm', id]);
  });
});
