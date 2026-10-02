// 実機の通し: 実物の claude(haiku)で確かめる(シナリオ 16、23、33、34、35、41、45、51、完了条件 2)。
// npm run test:real で流す。利用者の whatnext とそのセッションには触れない。

import {spawn} from 'node:child_process';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {cleanupSessions, launchOutside, PERM_PROMPT, RealHarness, sleep, testSessions, waitState} from './harness.js';

let h: RealHarness;

beforeAll(async () => {
  cleanupSessions();
  await new RealHarness().ensureTrusted();
});
afterEach(() => {
  if (process.env.WN_KEEP_LOG) console.log(h?.debugLog());
  h?.cleanup();
});
afterAll(() => cleanupSessions());

/** n で haiku のセッションを起動して attach する。 */
async function launchViaN(): Promise<void> {
  await h.keys('t', 'n');
  await h.waitFor('t', 'working directory:');
  await h.keys('t', 'Enter');
  await h.waitFor('t', 'model:');
  await h.keys('t', 'Down', 'Enter');
  await h.waitFor('t', 'Model:');
  await h.type('t', 'haiku');
  await h.keys('t', 'Enter');
  await h.waitFor('t', /\^Q\^L back/, 60000);
  await sleep(2500);
}

async function send(text: string): Promise<void> {
  await h.type('t', text);
  await sleep(300);
  await h.keys('t', 'Enter');
}

describe('whatnext から起動したセッション', () => {
  it('完了条件2、23、45、16: 最初の依頼の概要がすぐ出る。権限待ちの一言、断ったあとの Declined、レビュー待ちの一言と CTX', async () => {
    h = new RealHarness();
    h.open('t');
    await h.waitFor('t', /SESSION|No sessions to show/);
    await launchViaN();
    const tag = Date.now().toString(36);
    const sentAt = Date.now();
    await send(PERM_PROMPT(tag));
    // 完了条件2: 最初の依頼を送ったら、更新を待たずに数秒で概要の行に出る
    await h.waitFor('t', /^\S+ · Use the Bash tool to run exactly/m, 15000);
    expect(Date.now() - sentAt).toBeLessThan(15000);
    // 権限の確認がふだんどおり出る
    await h.waitFor('t', /date > \/private\/tmp\/claude-501\/wn-real/, 60000);
    await h.keys('t', 'C-q', 'C-l');
    let s = await h.refreshUntil('t', /Permission[^\n]*\n\s+Bash: date > \/private\/tmp\/claude-501\/wn-real/);
    expect(s).toMatch(/Last attached/);
    // 断る(45)
    await h.keys('t', 'Enter');
    await h.waitFor('t', /date > \/private\/tmp/);
    await h.keys('t', 'Escape');
    await sleep(2000);
    await h.keys('t', 'C-q', 'C-l');
    s = await h.refreshUntil('t', /Question[^\n]*\n\s+Declined: Bash: date > /);
    // 次の指示でターンを終える(23、16)
    await h.keys('t', 'Enter');
    await sleep(1500);
    await send('Do not use any tools. Reply with exactly: All done here.');
    await sleep(1000);
    await h.keys('t', 'C-q', 'C-l');
    s = await h.refreshUntil('t', /Review +\S+ +\d+k[^\n]*\n\s+All done here\./, 120000);
    expect(s).not.toMatch(/Review +\S+ +- /);
  });

  it('23、34: 指示を出してすぐ離脱すると → 指示。whatnext を終了している間にターンを終えても、フックのエラーは出ず、起動し直すと最初の一覧から最後の応答の冒頭が出る', async () => {
    h = new RealHarness();
    h.open('t');
    await h.waitFor('t', /SESSION|No sessions to show/);
    await launchViaN();
    await send('Do not use any tools. Write a 150-word paragraph about rivers, then end with the line: River end.');
    await h.keys('t', 'C-q', 'C-l');
    let s = await h.refreshUntil('t', /Working[^\n]*\n\s+→ Do not use any tools\. Write a 150-word/, 30000);
    const name = (s.split('\n').find(l => /^> /.test(l)) ?? '').replace(/^> /, '').split(/\s+/)[0] as string;
    await h.keys('t', 'q');
    await h.waitFor('t', /\[exit 0\]/);
    const id = testSessions().find(r => r.name === name || r.id === name)?.id as string;
    await waitState(id, r => r.state === 'done', 120000);
    const doneAt = Date.now();
    h.open('t2');
    s = await h.waitFor('t2', 'SESSION');
    await sleep(1500);
    s = h.screen('t2');
    const lines = s.split('\n');
    const i = lines.findIndex(l => l.includes(id) || l.includes(name));
    expect(lines[i]).toMatch(/Review +\S+ +- +(<1m|\dm)/);
    expect(lines[i + 1]).toMatch(/\S/);
    expect(Date.now() - doneAt).toBeLessThan(60000);
    // セッションの画面にフックのエラーが出ていない
    await h.select('t2', name);
    await h.keys('t2', 'Enter');
    await sleep(4000);
    expect(h.screen('t2')).not.toMatch(/hook error/i);
  });
});

describe('whatnext の外で起動したセッション', () => {
  it('33、45: 権限待ちの一言と待機時間が最初の一覧から出て、CTX は -。断ると Declined', async () => {
    h = new RealHarness();
    const tag = Date.now().toString(36);
    const id = launchOutside(PERM_PROMPT(tag), `wn-real-perm-${tag}`);
    await waitState(id, r => r.waitingFor === 'permission prompt');
    await sleep(65000);
    h.open('t');
    const s = await h.waitFor('t', new RegExp(`wn-real-perm-${tag}`));
    const line = s.split('\n').find(l => l.includes(`wn-real-perm-${tag}`)) ?? '';
    expect(line).toMatch(/Permission +\S+ +- +\d+m/);
    expect(s).toMatch(/Bash: date > \/private\/tmp\/claude-501\/wn-real/);
    await h.select('t', `wn-real-perm-${tag}`);
    await h.keys('t', 'Enter');
    await h.waitFor('t', /date > \/private\/tmp/);
    await h.keys('t', 'Escape');
    await sleep(2000);
    await h.keys('t', 'C-q', 'C-l');
    await h.refreshUntil('t', /Declined: Bash: date > /);
  });

  it('33、34: 稼働中は → 指示、終わるとレビュー待ちの一言。whatnext を起動し直しても最初の一覧から出る', async () => {
    h = new RealHarness();
    const tag = Date.now().toString(36);
    const id = launchOutside(
      'Do not use any tools. Write a 120-word paragraph about tea, then end with: Tea time.',
      `wn-real-tea-${tag}`,
    );
    h.open('t');
    await h.waitFor('t', new RegExp(`wn-real-tea-${tag}`));
    await waitState(id, r => r.state === 'done');
    await h.keys('t', 'q');
    await h.waitFor('t', /\[exit 0\]/);
    h.open('t2');
    const s = await h.waitFor('t2', new RegExp(`wn-real-tea-${tag}`));
    const lines = s.split('\n');
    const i = lines.findIndex(l => l.includes(`wn-real-tea-${tag}`));
    expect(lines[i]).toMatch(/Review +\S+ +- +(<1m|\dm)/);
    expect(lines[i + 1]?.trim().length).toBeGreaterThan(10);
  });

  it('35: 外で起動したセッションを保留にし、attach して指示を出しターンが終わるまで待って戻ると、保留が解ける', async () => {
    h = new RealHarness();
    const tag = Date.now().toString(36);
    const id = launchOutside('Do not use any tools. Reply with exactly: ready.', `wn-real-hold-${tag}`);
    await waitState(id, r => r.state === 'done');
    h.open('t');
    await h.waitFor('t', `wn-real-hold-${tag}`);
    await h.select('t', `wn-real-hold-${tag}`);
    await h.keys('t', 'h', 'Enter');
    await h.waitFor('t', 'On hold');
    // 何も入力せずに戻ると残る
    await h.select('t', `wn-real-hold-${tag}`);
    await h.keys('t', 'Enter');
    await sleep(4000);
    await h.keys('t', 'C-q', 'C-l');
    await h.waitFor('t', 'On hold');
    await h.keys('t', 'Enter');
    await sleep(4000);
    await send('Do not use any tools. Reply with exactly: again.');
    await waitState(id, r => r.state === 'working' || r.status === 'busy', 30000).catch(() => undefined);
    await waitState(id, r => r.state === 'done');
    await sleep(1000);
    await h.keys('t', 'C-q', 'C-l');
    const s = await h.waitFor('t', 'Last attached');
    expect(s).not.toContain('On hold');
  });

  it('51: 選んでいる行を外で claude rm すると、移った先の行への Ctrl+X は受け付けない', async () => {
    h = new RealHarness();
    const tag = Date.now().toString(36);
    const a = launchOutside('Do not use any tools. Reply with exactly: a.', `wn-real-a-${tag}`);
    launchOutside('Do not use any tools. Reply with exactly: b.', `wn-real-b-${tag}`);
    await waitState(a, r => r.state === 'done');
    h.open('t');
    await h.waitFor('t', `wn-real-b-${tag}`);
    await h.select('t', `wn-real-a-${tag}`);
    const {execFileSync} = await import('node:child_process');
    execFileSync('claude', ['stop', a]);
    await sleep(3000);
    execFileSync('claude', ['rm', a]);
    await h.keys('t', 'r');
    await h.waitFor('t', /Refreshed\./);
    await h.keys('t', 'C-x');
    await h.waitFor('t', `Ctrl+X ignored: wn-real-a-${tag} left the list and the selection moved.`);
    expect(testSessions().some(r => r.name === `wn-real-b-${tag}` && r.state === 'stopped')).toBe(false);
  });
});

describe('受け口のポートをほかのプログラムが使っているとき', () => {
  it('41: n で起動したセッションにフックと OTel が付かず、一言は会話記録から出て CTX は -', async () => {
    h = new RealHarness();
    const blocker = spawn('python3', ['-m', 'http.server', String(h.port), '--bind', '127.0.0.1'], {stdio: 'ignore'});
    try {
      await sleep(1500);
      h.open('t');
      await h.waitFor('t', /SESSION|No sessions to show/);
      await launchViaN();
      await send('Do not use any tools. Reply with exactly: Port test done.');
      await sleep(1000);
      await h.keys('t', 'C-q', 'C-l');
      const s = await h.refreshUntil('t', /Review +\S+ +- [^\n]*\n\s+Port test done\./, 120000);
      expect(s).toBeTruthy();
    } finally {
      blocker.kill();
    }
  });
});
