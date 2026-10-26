import {type ChildProcess, execFileSync, spawn} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {REPO, sleep} from '../e2e/harness.js';
import {
  agents,
  cleanEnv,
  mine,
  PERMISSION_PROMPT,
  RealHarness,
  removeMine,
  startBg,
  WORK,
  waitAgent,
} from './real-harness.js';

// 実機の通し(DESIGN.md「確かめ方」)。本物の claude(haiku)を使う。流す前に、テストのセッション(wn-real-…)の
// 権限の確認に答えないよう利用者に伝える。利用者の本物のセッションも一覧に並ぶので、確かめるのはテストの行とその組だけにする。

let h: RealHarness;

beforeAll(async () => {
  await removeMine();
});
afterEach(async () => {
  h?.cleanup();
  await removeMine();
});

/** `n` で WORK に haiku のセッションを起動して attach する。 */
async function launchHaiku(): Promise<void> {
  await h.keys('n');
  await h.waitFor(/New session in:/);
  await h.type('zzzqqqx');
  await h.keys('Enter');
  await h.waitFor(/Directory: zzzqqqx█/);
  await h.keys('C-u');
  await h.type(WORK);
  await h.keys('Enter');
  await h.waitFor(/Model for/);
  await h.keys('Down', 'Enter');
  await h.waitFor(/Model: █/);
  await h.type('haiku');
  await h.keys('Enter');
  await h.waitFor(/\^Q\^L back/, 60000);
  await sleep(3000);
}

async function sendPrompt(text: string): Promise<void> {
  await h.type(text);
  await sleep(300);
  await h.keys('Enter');
}

async function refreshUntil(pred: () => boolean, timeout = 90000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await h.refresh();
    if (pred()) return;
    await sleep(2000);
  }
  throw new Error(`refreshUntil timed out:\n${h.screen()}`);
}

const newId = (before: Set<string>) => mine().find(a => a.id && !before.has(a.id))?.id as string;

/** 今の名前(`--bg` のセッションはターンを終えると名前が付け直される)。 */
const nm = (id: string) => mine().find(a => a.id === id)?.name ?? id;

describe('whatnext が起動したセッション', () => {
  it('23・45・16・概要の行: 権限待ちの対象、断った道具、最後の応答の冒頭、CTX が出る。最初の依頼はすぐ概要の行に出る', async () => {
    h = new RealHarness();
    await h.start({size: {cols: 150, rows: 45}});
    const before = new Set(mine().map(a => a.id as string));
    await launchHaiku();
    await sendPrompt(PERMISSION_PROMPT('n1'));
    // 概要の行(フックを受けて、更新を待たずに出る)
    await h.waitFor(/[0-9a-f]{8} · Use the Bash tool to run exactly/, 20000);
    await waitAgent(a => a.some(x => x.id && !before.has(x.id) && x.waitingFor === 'permission prompt'));
    const id = newId(before);
    await h.waitFor(/Do you want|Yes/, 20000);
    await h.keys('C-q', 'C-l');
    await refreshUntil(() => /Permission/.test(h.row(nm(id)) ?? ''));
    expect(h.notes(nm(id)).join('\n')).toMatch(/Bash: date > \/private\/tmp\/claude-501\/wn-real-n1\.txt/);
    // 断る
    await h.keys('Enter');
    await h.waitFor(/Do you want|Yes/, 20000);
    await h.keys('Escape');
    await sleep(2000);
    await h.keys('C-q', 'C-l');
    await refreshUntil(() => /Question/.test(h.row(nm(id)) ?? ''));
    expect(h.notes(nm(id)).join('\n')).toMatch(/Declined: Bash: date >/);
    // 次の指示でターンを終える
    await h.keys('Enter');
    await sleep(2000);
    await sendPrompt('Reply with exactly the word: finished');
    await h.keys('C-q', 'C-l');
    await waitAgent(a => a.some(x => x.id === id && x.state === 'done'), 90000);
    await refreshUntil(() => /Review/.test(h.row(nm(id)) ?? ''));
    expect(h.notes(nm(id)).join('\n')).toMatch(/finished/);
    expect(h.row(nm(id))).toMatch(/\d+k +(<1m|\dm)$/);
  });

  it('34: whatnext を終了している間にターンを終えても、起動し直した最初の一覧に最後の応答の冒頭が出る', async () => {
    h = new RealHarness();
    await h.start({size: {cols: 150, rows: 45}});
    const before = new Set(mine().map(a => a.id as string));
    await launchHaiku();
    await sendPrompt('Write about 150 words about green tea. Do not use any tools. Start with the word Tea.');
    await sleep(1500);
    await h.keys('C-q', 'C-l');
    await h.waitFor(/SESSION/);
    const id = newId(before);
    await h.keys('q');
    await h.waitFor(/\[exit 0\]/);
    await waitAgent(a => a.some(x => x.id === id && x.state === 'done'), 90000);
    await sleep(3000);
    await h.start({size: {cols: 150, rows: 45}});
    expect(h.row(nm(id))).toMatch(/Review.*(<1m|\dm)$/);
    expect(h.notes(nm(id)).join('\n')).toMatch(/Tea/);
  });

  it('41: 受け口のポートをほかのプログラムが使っているときは、フックも OTel も付かず、一言は会話記録から出て CTX は -', async () => {
    h = new RealHarness();
    h.port = 15000 + Math.floor(Math.random() * 900);
    const py: ChildProcess = spawn('python3', ['-m', 'http.server', String(h.port), '--bind', '127.0.0.1'], {
      stdio: 'ignore',
      cwd: h.dir,
    });
    try {
      await sleep(1500);
      await h.start({size: {cols: 150, rows: 45}});
      const before = new Set(mine().map(a => a.id as string));
      await launchHaiku();
      await sendPrompt('Reply with exactly the word: pong');
      await h.keys('C-q', 'C-l');
      const id = await (async () => {
        await waitAgent(a => a.some(x => x.id && !before.has(x.id)));
        return newId(before);
      })();
      await waitAgent(a => a.some(x => x.id === id && x.state === 'done'), 90000);
      await sleep(3000);
      await refreshUntil(() => /Review/.test(h.row(nm(id)) ?? ''));
      expect(h.notes(nm(id)).join('\n')).toMatch(/pong/);
      expect(h.row(nm(id))).toMatch(/Review +- +/);
      expect(h.log()).toMatch(/occupant=other receiver=none/);
    } finally {
      py.kill();
    }
  });
});

describe('whatnext の外で起動したセッション', () => {
  it('33・45: 権限待ちの対象と AGE が最初の一覧から出て、CTX は -。断ると Declined、終えると最後の応答の冒頭', async () => {
    const id = startBg('wn-real-ext', PERMISSION_PROMPT('ext'));
    await waitAgent(a => a.some(x => x.id === id && x.waitingFor === 'permission prompt'));
    await sleep(2000);
    h = new RealHarness();
    await h.start({size: {cols: 150, rows: 45}});
    expect(h.row('wn-real-ext')).toMatch(/Permission +- +(<1m|\dm)$/);
    expect(h.notes('wn-real-ext').join('\n')).toMatch(/Bash: date > \/private\/tmp\/claude-501\/wn-real-ext\.txt/);
    await h.select('wn-real-ext');
    await h.keys('Enter');
    await h.waitFor(/Do you want|Yes/, 20000);
    await h.keys('Escape');
    await sleep(2000);
    await h.keys('C-q', 'C-l');
    await refreshUntil(() => /Question/.test(h.row('wn-real-ext') ?? ''));
    expect(h.notes('wn-real-ext').join('\n')).toMatch(/Declined: Bash: date >/);
    await h.keys('Enter');
    await sleep(2000);
    await sendPrompt('Write about 120 words about oolong tea. Do not use any tools. Start with the word Oolong.');
    await sleep(1500);
    await h.keys('C-q', 'C-l');
    await h.refresh();
    const r = h.row('wn-real-ext') ?? '';
    if (/Working/.test(r)) expect(h.notes('wn-real-ext').join('\n')).toMatch(/→ Write about 120 words/);
    await waitAgent(a => a.some(x => x.id === id && x.state === 'done'), 90000);
    await sleep(2000);
    await refreshUntil(() => /Review/.test(h.row('wn-real-ext') ?? ''));
    expect(h.notes('wn-real-ext').join('\n')).toMatch(/Oolong/);
  });

  it('51: 選んでいる行を外で消すと、カーソルが移った直後の Ctrl+X は受け付けない', async () => {
    const g1 = startBg('wn-real-g1');
    startBg('wn-real-g2');
    await waitAgent(a => a.filter(x => x.name?.startsWith('wn-real-g')).length === 2);
    h = new RealHarness();
    await h.start({size: {cols: 150, rows: 45}});
    await h.select('wn-real-g1');
    execFileSync('claude', ['stop', g1], {stdio: 'ignore', env: cleanEnv()});
    await sleep(3000);
    execFileSync('claude', ['rm', g1], {stdio: 'ignore', env: cleanEnv()});
    await h.refresh();
    expect(h.screen()).not.toMatch(/wn-real-g1/);
    await h.keys('C-x');
    await h.waitFor(/Ctrl\+X ignored: wn-real-g1 left the list and the selection moved\./);
  });

  it('67: --bg のセッションが Bash で起動した claude -p は、起動元の下に (sub) で入れ子になる', async () => {
    startBg(
      'wn-real-orch',
      'Use the Bash tool to run exactly this command and wait for it: claude -p "Count from 1 to 400 in English words, one number per line. Do not use any tools." --model haiku . Then reply finished.',
      ['--allowedTools', 'Bash(claude -p:*)'],
    );
    await waitAgent(a => a.some(x => x.kind === 'interactive' && x.status === 'busy'), 90000);
    h = new RealHarness();
    await h.start({size: {cols: 150, rows: 45}});
    await refreshUntil(() => {
      const ls = h.lines();
      const i = ls.findIndex(l => /^[> ] wn-real-orch/.test(l));
      return i >= 0 && ls.slice(i + 1, i + 6).some(l => /^[> ] [│ ]*└ \S+ \(sub\) +Working/.test(l));
    }, 60000);
  });
});

describe('会話の外の MCP サーバ(77)', () => {
  const dir = '/private/tmp/whatnext-real-mcp';
  const port = 15800 + Math.floor(Math.random() * 100);
  let serverPid = 0;

  beforeAll(() => {
    execFileSync('mkdir', ['-p', dir]);
    writeFileSync(join(dir, 'server.log'), '');
    writeFileSync(join(dir, 'helper.sh'), `#!/bin/sh\nprintf '{"X-MCP-Caller-Pid": "%s"}' "$PPID"\n`, {mode: 0o755});
    const url = `http://127.0.0.1:${port}/mcp`;
    writeFileSync(
      join(dir, 'with.json'),
      JSON.stringify({mcpServers: {wnspawn: {type: 'http', url, headersHelper: join(dir, 'helper.sh')}}}),
    );
    writeFileSync(join(dir, 'without.json'), JSON.stringify({mcpServers: {wnspawn: {type: 'http', url}}}));
    // 親を pid 1 にして常駐させる(sh がすぐ終わる)
    execFileSync(
      'sh',
      [
        '-c',
        `WN_WORK=${WORK} nohup node ${join(REPO, 'test', 'real', 'mcp-server.mjs')} ${port} ${join(dir, 'server.log')} pass >/dev/null 2>&1 &`,
      ],
      {env: cleanEnv()},
    );
    const out = execFileSync('sh', ['-c', `sleep 1; lsof -nP -iTCP:${port} -sTCP:LISTEN -t`], {encoding: 'utf8'});
    serverPid = Number(out.trim().split('\n')[0]);
  });
  afterAll(() => {
    if (serverPid) {
      try {
        process.kill(serverPid);
      } catch {}
    }
  });

  it('77: 2つのセッションが同じサーバで起動した行は、それぞれの起動元の下に (sub) で並ぶ。MCP_CALLER_PID のない行は (tty)', async () => {
    const call = (label: string) =>
      `Call the spawn tool of the wnspawn server exactly once with label ${label}. Then reply OK.`;
    const allow = ['--allowedTools', 'mcp__wnspawn__spawn'];
    startBg('wn-real-mcp-P', call('fromP'), ['--mcp-config', join(dir, 'with.json'), ...allow]);
    startBg('wn-real-mcp-R', call('fromR'), ['--mcp-config', join(dir, 'with.json'), ...allow]);
    startBg('wn-real-mcp-Q', call('fromQ'), ['--mcp-config', join(dir, 'without.json'), ...allow]);
    const spawned = async () => {
      const log = readFileSync(join(dir, 'server.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l));
      return log.filter(e => e.spawned);
    };
    const end = Date.now() + 120000;
    let s: {spawned: number; label: string; passed: string | null}[] = [];
    while (Date.now() < end) {
      s = await spawned();
      if (s.length >= 3) break;
      await sleep(2000);
    }
    expect(s.length).toBeGreaterThanOrEqual(3);
    const nameOf = (label: string) =>
      agents().find(a => a.pid === s.find(x => x.label === label)?.spawned)?.name as string;
    await waitAgent(() => ['fromP', 'fromR', 'fromQ'].every(l => nameOf(l)), 60000);
    h = new RealHarness();
    await h.start({size: {cols: 160, rows: 50}});
    const under = (parent: string, child: string) => {
      const ls = h.lines();
      const i = ls.findIndex(l => /^[> ] /.test(l) && l.includes(parent));
      const j = ls.findIndex(l => l.includes(`${child} (sub)`));
      return (
        i >= 0 && j > i && /^[> ] [│ ]*[└├] /.test(ls[j]) && !ls.slice(i + 1, j).some(l => /^[> ] [^\s│├└]/.test(l))
      );
    };
    const ok = () => {
      const [p2, r2, q2] = ['fromP', 'fromR', 'fromQ'].map(nameOf);
      return (
        under('wn-real-mcp-P', p2) &&
        under('wn-real-mcp-R', r2) &&
        new RegExp(`^[> ] ${q2} \\(tty\\)`, 'm').test(h.screen())
      );
    };
    try {
      await refreshUntil(ok, 40000);
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${JSON.stringify(mine().filter(a => a.kind === 'interactive'))}`);
    }
  });
});
