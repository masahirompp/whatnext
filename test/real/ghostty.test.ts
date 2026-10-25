import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {CLI, sleep} from '../e2e/harness.js';
import {RealHarness, removeMine, startBg, waitAgent} from './real-harness.js';

// 58a: Ghostty で ctrl+q ctrl+w と一覧の w が、作業台の画面の分割を作る(なければ)か、その分割へ移る(あれば)。
// AppleScript で前面に新しいウィンドウを開いて操作し、終わったら閉じる(working-with-tmux、driving-whatnext-in-tmux スキル)。

const osa = (script: string): string => execFileSync('osascript', ['-e', script], {encoding: 'utf8'}).trim();
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

let h: RealHarness;
let win = '';
afterEach(async () => {
  if (win) {
    try {
      osa(`tell application "Ghostty" to close window id "${win}"`);
    } catch {}
  }
  win = '';
  h?.cleanup();
  await removeMine();
});

const terms = (): {id: string; name: string}[] =>
  osa(
    `tell application "Ghostty"
      set out to ""
      repeat with t in terminals of selected tab of (first window whose id is "${win}")
        set out to out & (id of t) & (character id 9) & (name of t) & (character id 10)
      end repeat
      return out
    end tell`,
  )
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [id, name] = l.split('\t');
      return {id, name};
    });

const focusedName = () =>
  osa(
    `tell application "Ghostty" to return name of focused terminal of selected tab of (first window whose id is "${win}")`,
  );

async function until(pred: () => boolean, timeout = 15000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(300);
  }
  throw new Error(`timed out: ${what}; terminals ${JSON.stringify(terms())}`);
}

/** Ghostty を前面に出し、左の分割にフォーカスを戻す(テストの最中に別のアプリが前に出ると、whatnext は分割を作らない)。 */
const focusLeft = (left: string) =>
  osa(`tell application "Ghostty"
    activate
    focus (first terminal whose id is "${left}")
  end tell`);

/** 一覧のペインに直接キーを送る(修飾キーのない文字は Ghostty の send key では届かないため)。 */
const listKey = (...ks: string[]) => {
  for (const k of ks) h.inner('send-keys', '-t', '=list:', k);
};
const listScreen = () => h.inner('capture-pane', '-p', '-t', '=list:');

async function selectInList(name: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (new RegExp(`^> .*${name}`, 'm').test(listScreen())) return;
    listKey('Down');
    await sleep(200);
  }
  throw new Error(`could not select ${name}:\n${listScreen()}`);
}

describe('Ghostty(58a)', () => {
  it('ctrl+q ctrl+w と一覧の w は、作業台の画面の分割を右に作り、あればその分割へ移る。ふだんのシェルの分割には触れない', async () => {
    startBg('wn-real-gh');
    await waitAgent(a => a.some(x => x.name === 'wn-real-gh'));
    h = new RealHarness();
    h.port = 15200 + Math.floor(Math.random() * 300);
    const script = join(h.dir, 'launch.sh');
    writeFileSync(script, `${h.envLine()} node ${CLI}\n`);
    win = osa(
      `tell application "Ghostty"
        activate
        set cfg to new surface configuration
        set initial input of cfg to "sh ${q(script)}\\n"
        set w to new window with configuration cfg
        return id of w
      end tell`,
    );
    await until(() => /SESSION/.test(listScreen()), 20000, 'list');
    const left = terms()[0].id;
    // ふだんのシェルの分割を先に作っておく
    osa(`tell application "Ghostty" to split (first terminal whose id is "${left}") direction right`);
    await until(() => terms().length === 2, 5000, 'shell split');
    const shell = terms().find(t => t.id !== left)?.id as string;
    focusLeft(left);
    await sleep(500);
    // claude の画面で ctrl+q ctrl+w
    await selectInList('wn-real-gh');
    listKey('Enter');
    await until(() => h.clients().some(c => /^[0-9a-f]{8}$/.test(c.session)), 20000, 'attach');
    await sleep(3000);
    osa(
      `tell application "Ghostty"
        activate
        set t to first terminal whose id is "${left}"
        send key "q" modifiers "control" to t
        send key "w" modifiers "control" to t
      end tell`,
    );
    await until(() => terms().length === 3, 15000, 'workbench split');
    await until(() => terms().some(t => t.name === 'whatnext workbench'), 10000, 'workbench title');
    await until(() => focusedName() === 'whatnext workbench', 5000, 'focus on workbench');
    expect(h.sessions().some(s => s.startsWith('sh-'))).toBe(true);
    // 左に戻ってもう一度押すと、分割は増えずにフォーカスだけが移る
    focusLeft(left);
    await sleep(500);
    osa(
      `tell application "Ghostty"
        activate
        set t to first terminal whose id is "${left}"
        send key "q" modifiers "control" to t
        send key "w" modifiers "control" to t
      end tell`,
    );
    await until(() => focusedName() === 'whatnext workbench', 8000, 'focus again');
    expect(terms().length).toBe(3);
    // ふだんのシェルの分割には何も入力されていない(名前と id がそのまま)
    expect(terms().some(t => t.id === shell)).toBe(true);
    // 一覧に戻って w を押しても同じく移るだけ
    focusLeft(left);
    await sleep(300);
    osa(
      `tell application "Ghostty"
        activate
        set t to first terminal whose id is "${left}"
        send key "q" modifiers "control" to t
        send key "l" modifiers "control" to t
      end tell`,
    );
    await until(() => h.clients().some(c => c.session === 'list'), 8000, 'back to list');
    focusLeft(left);
    await sleep(300);
    listKey('w');
    await until(() => focusedName() === 'whatnext workbench', 8000, 'focus by w');
    expect(terms().length).toBe(3);
    // whatnext を終了すると、whatnext が作った分割は閉じる
    listKey('q');
    await until(() => terms().length === 2, 15000, 'split closed');
    expect(terms().some(t => t.id === shell)).toBe(true);
    // 一覧の w でも、なければ右に分割を作る
    osa(`tell application "Ghostty" to input text "sh ${q(script)}" to (first terminal whose id is "${left}")`);
    osa(`tell application "Ghostty" to send key "enter" to (first terminal whose id is "${left}")`);
    await until(() => /SESSION/.test(listScreen()), 20000, 'list again');
    focusLeft(left);
    await sleep(300);
    await selectInList('wn-real-gh');
    listKey('w');
    await until(() => terms().length === 3, 15000, 'split by w');
    await until(() => focusedName() === 'whatnext workbench', 8000, 'focus after w');
    listKey('q');
    await until(() => terms().length === 2, 15000, 'split closed again');
  });
});
