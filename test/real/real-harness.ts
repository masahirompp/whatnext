import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {stripControl} from '../../lib/input/exec.js';
import {Transcripts} from '../../lib/input/transcript.js';
import {Harness, sleep} from '../e2e/harness.js';

// 実機の通しの口。本物の claude(haiku)を使い、ソケット、ポート、状態のファイルはテスト用に分ける。
// セッションは信頼の確認を済ませた WORK で起動し、終わったら WORK のセッションだけを止めて消す。

export const WORK = '/private/tmp/whatnext-real';

export interface Agent {
  kind: string;
  sessionId: string;
  id?: string;
  cwd: string;
  name?: string;
  pid?: number;
  state?: string;
  status?: string;
  waitingFor?: string;
}

/** Claude Code の中のシェルから起動したときに引き継ぐ印を外す(外さないと対話セッションが --json に出ない。#284)。 */
const CLEAN = '-u CLAUDE_CODE_CHILD_SESSION -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u ANTHROPIC_MODEL';

export function cleanEnv(): NodeJS.ProcessEnv {
  const e = {...process.env};
  for (const k of [
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'ANTHROPIC_MODEL',
    'TMUX',
    'TMUX_PANE',
  ])
    delete e[k];
  e.WHATNEXT_ROLE = '';
  return e;
}

export function agents(): Agent[] {
  const out = execFileSync('claude', ['agents', '--json', '--all'], {encoding: 'utf8', env: cleanEnv()});
  return JSON.parse(out) as Agent[];
}

export const mine = () => agents().filter(a => a.cwd === WORK || a.cwd === '/tmp/whatnext-real');

export async function waitAgent(pred: (a: Agent[]) => boolean, timeout = 60000): Promise<Agent[]> {
  const end = Date.now() + timeout;
  let a: Agent[] = [];
  while (Date.now() < end) {
    a = mine();
    if (pred(a)) return a;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for agents: ${JSON.stringify(a)}`);
}

/** whatnext を通さずに `claude --bg` で起動する(フックが付かない)。id を返す。 */
export function startBg(name: string, prompt?: string, extra: string[] = []): string {
  const args = ['--bg', '--model', 'haiku', '--name', name, ...extra, ...(prompt ? ['--', prompt] : [])];
  const out = execFileSync('claude', args, {cwd: WORK, encoding: 'utf8', env: cleanEnv()});
  const m = /backgrounded\s*·\s*([0-9a-f]{8})/.exec(stripControl(out));
  if (!m) throw new Error(`no id: ${out}`);
  return m[1];
}

/**
 * WORK のプロジェクトの設定を書く。毎回中身ごと書き直し、テストのあとも残す(WORK はテスト専用)。
 * - model: whatnext の n はモデルを選ばないので、n で起動するセッションを haiku にする。環境変数(ANTHROPIC_MODEL)で
 *   渡すと、whatnext が起こしたデーモンを通して WORK の外のセッションにまで残りうる。効くことは modelOf で確かめる
 * - permissions.defaultMode: 利用者の既定が auto だと権限の確認が出ず、権限待ちのシナリオが成り立たない
 */
export function writeWorkSettings(): void {
  mkdirSync(join(WORK, '.claude'), {recursive: true});
  const settings = {model: 'haiku', permissions: {defaultMode: 'default'}};
  writeFileSync(join(WORK, '.claude', 'settings.local.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

/** 会話記録にある応答のモデル名(最後のもの)。会話記録もモデル名もなければ undefined。 */
export async function modelOf(sessionId: string): Promise<string | undefined> {
  const path = await new Transcripts(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')).locate(sessionId);
  if (!path) return undefined;
  let model: string | undefined;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const m = (JSON.parse(line) as {message?: {model?: string}}).message?.model;
      if (m && m !== '<synthetic>') model = m;
    } catch {}
  }
  return model;
}

/** WORK のセッションを止めて消す。 */
export async function removeMine(): Promise<void> {
  for (const a of mine()) {
    if (!a.id) continue;
    try {
      execFileSync('claude', ['stop', a.id], {stdio: 'ignore', env: cleanEnv()});
    } catch {}
  }
  await sleep(3000);
  for (const a of mine()) {
    if (!a.id) continue;
    try {
      execFileSync('claude', ['rm', a.id], {stdio: 'ignore', env: cleanEnv()});
    } catch {}
  }
}

/** 権限の確認が出る指示(cwd の外へ書く Bash。claude-code-behavior.md「試験用の権限待ちの行を作る」)。 */
export const PERMISSION_PROMPT = (tag: string) =>
  `Use the Bash tool to run exactly: date > /private/tmp/claude-501/wn-real-${tag}.txt . Then report the result.`;

export class RealHarness extends Harness {
  override envLine(extra: Record<string, string> = {}): string {
    const vars: Record<string, string> = {
      WHATNEXT_ROLE: '',
      WHATNEXT_TMUX_SOCKET: this.socket,
      WHATNEXT_PORT: String(this.port),
      XDG_STATE_HOME: join(this.dir, 'state'),
      WHATNEXT_DEBUG_LOG: join(this.dir, 'debug.log'),
      ...extra,
    };
    const assigns = Object.entries(vars).map(([k, v]) => `${k}='${v}'`);
    return `env -u TMUX -u TMUX_PANE ${CLEAN} ${assigns.join(' ')}`;
  }

  /** 一覧で、名前の行(組の中の行を含む)の文字列を返す。 */
  row(name: string): string | undefined {
    return this.lines().find(l => /^[> ] /.test(l) && l.includes(name));
  }

  /** 名前の行の下の注記(次の行まで)を返す。 */
  notes(name: string): string[] {
    const ls = this.lines();
    const i = ls.findIndex(l => /^[> ] /.test(l) && l.includes(name));
    if (i < 0) return [];
    const out: string[] = [];
    // 行は CTX と AGE の列で終わる。注記の行はそうならない
    const isRow = (l: string) => /\s(-|\d+k?|\d+\.\dM)\s+(-|<1m|\d+[mhd])$/.test(l);
    for (let j = i + 1; j < ls.length; j++) {
      const l = ls[j];
      if (/^\s*$/.test(l) || /^──/.test(l) || isRow(l)) break;
      out.push(l.replace(/^[\s│]+/, ''));
    }
    return out;
  }
}
