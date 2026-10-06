import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseAgents, parseUsage} from '../../src/input/claude.js';
import {HookStore, supplement} from '../../src/input/hooks.js';
import {launchSettings} from '../../src/input/receiver.js';
import {instructionText, leadLine, toolTarget} from '../../src/input/text.js';
import {Transcripts} from '../../src/input/transcript.js';
import {loadState, StateWriter, statePath} from '../../src/state/store.js';

describe('最後の応答の冒頭 (シナリオ 39)', () => {
  it('区切り線や箇条書きで始まっても、記号とバッククォートを除いた最初の中身の行', () => {
    expect(leadLine('---\n\n- **Fixed** the `login` bug\n')).toBe('Fixed the login bug');
    expect(leadLine('## 結果\n本文')).toBe('結果');
    expect(leadLine('> quoted')).toBe('quoted');
    expect(leadLine('1. first step')).toBe('first step');
    expect(leadLine('| a | b |\n|---|---|\ntext')).toBe('text');
  });

  it('コードの囲みで始まるときは囲みの後の最初の行、囲みだけなら囲みの中の1行目', () => {
    expect(leadLine('```\ncode\n```\nafter')).toBe('after');
    expect(leadLine('```sh\nnpm test\nmore\n```')).toBe('npm test');
  });

  it('空なら undefined', () => {
    expect(leadLine('\n\n')).toBeUndefined();
  });
});

describe('指示と道具', () => {
  it('ターンを始めるコマンドは /名前 引数、手元のコマンドは指示に数えない', () => {
    expect(
      instructionText(
        '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>12</command-args>',
      ),
    ).toBe('/review 12');
    expect(
      instructionText(
        '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>',
      ),
    ).toBeUndefined();
    expect(instructionText('<local-command-stdout>x</local-command-stdout>')).toBeUndefined();
    expect(instructionText('<bash-input>ls</bash-input>')).toBeUndefined();
    expect(instructionText('\nfix the bug\nplease')).toBe('fix the bug');
  });

  it('道具と対象', () => {
    expect(toolTarget('Bash', {command: 'npm test\nmore'})).toBe('Bash: npm test');
    expect(toolTarget('Edit', {file_path: '/a/b.ts'})).toBe('Edit: /a/b.ts');
    expect(toolTarget('Foo', {})).toBe('Foo');
  });
});

describe('--json の読み取り', () => {
  it('行を読み、壊れていればエラー', () => {
    const r = parseAgents('[{"kind":"background","sessionId":"s","id":"i","cwd":"/x","pid":3,"state":"done"}]');
    expect(r).toEqual({
      ok: true,
      rows: [{kind: 'background', sessionId: 's', id: 'i', cwd: '/x', pid: 3, state: 'done'}],
    });
    expect(parseAgents('not json').ok).toBe(false);
    expect(parseAgents('{}').ok).toBe(false);
  });
});

describe('Usage', () => {
  it('枠ごとの使用率とリセットする時刻。今日なら日付を省く', () => {
    const text = [
      'Current session: 42% used · resets Sep 25 at 2:09pm (Asia/Tokyo)',
      'Current week (all models): 25% used · resets Sep 29 at 9:59am (Asia/Tokyo)',
      'other line',
    ].join('\n');
    expect(parseUsage(text, new Date(2026, 8, 25, 10))).toEqual([
      {label: 'session', percent: 42, resets: '2:09pm'},
      {label: 'week (all models)', percent: 25, resets: 'Sep 29 9:59am'},
    ]);
  });
});

describe('フックと補う値', () => {
  it('フックの値を今のターンについてだけ使い、ないものを会話記録で補う', () => {
    let t = 1000;
    const store = new HookStore(() => t);
    store.receiveHook({session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'fix it\nmore'});
    t = 2000;
    store.receiveHook({
      session_id: 's',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: {command: 'rm -rf x'},
    });
    const s = supplement(store.get('s'), undefined, 3000);
    expect(s).toEqual({
      prompt: {text: 'fix it', at: 1000},
      haltAt: 2000,
      permission: 'Bash: rm -rf x',
      declined: 'Bash: rm -rf x',
      ctx: 3000,
    });
    t = 3000;
    store.receiveHook({session_id: 's', hook_event_name: 'Stop', last_assistant_message: '- Done `now`'});
    expect(supplement(store.get('s'), undefined, undefined)).toMatchObject({lastText: 'Done now', haltAt: 3000});
  });

  it('会話記録のほうが新しいターンなら、フックの古いターンの値を使わない', () => {
    const store = new HookStore(() => 1000);
    store.receiveHook({session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'old'});
    store.receiveHook({session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'old answer'});
    const s = supplement(store.get('s'), {prompt: {text: 'new', at: 60000}}, undefined);
    expect(s.prompt?.text).toBe('new');
    expect(s.lastText).toBeUndefined();
  });

  it('失敗は文言を、なければ符号を出す', () => {
    const store = new HookStore(() => 1);
    store.receiveHook({session_id: 'a', hook_event_name: 'StopFailure', error: 'model_not_found'});
    expect(supplement(store.get('a'), undefined, undefined).error).toBe('model_not_found');
    store.receiveHook({
      session_id: 'b',
      hook_event_name: 'StopFailure',
      error: 'x',
      last_assistant_message: 'API Error: 404',
    });
    expect(supplement(store.get('b'), undefined, undefined).error).toBe('API Error: 404');
  });

  it('OTel の api_request から本体のターンの CTX を取る', () => {
    const store = new HookStore();
    const rec = (source: string, input: number) => ({
      attributes: [
        {key: 'event.name', value: {stringValue: 'api_request'}},
        {key: 'session.id', value: {stringValue: 's'}},
        {key: 'query_source', value: {stringValue: source}},
        {key: 'input_tokens', value: {stringValue: String(input)}},
        {key: 'cache_read_tokens', value: {intValue: '30000'}},
        {key: 'cache_creation_tokens', value: {intValue: 1000}},
      ],
    });
    store.receiveLogs({
      resourceLogs: [{scopeLogs: [{logRecords: [rec('repl_main_thread', 5), rec('prompt_suggestion', 9)]}]}],
    });
    expect(store.ctxOf('s')).toBe(31005);
  });

  it('起動するセッションの設定にフックと OTel を付ける', () => {
    const s = JSON.parse(launchSettings(14399));
    expect(s.hooks.Stop[0].hooks[0].command).toBe(
      'curl -s -m 1 -o /dev/null --data-binary @- http://127.0.0.1:14399/v1/hooks; exit 0',
    );
    expect(s.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
    expect(s.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:14399');
  });
});

async function transcriptDir(lines: object[]): Promise<{dir: string; file: string}> {
  const dir = await mkdtemp(join(tmpdir(), 'wn-tr-'));
  await mkdir(join(dir, 'projects', '-x-worktree'), {recursive: true});
  const file = join(dir, 'projects', '-x-worktree', 'sid-1.jsonl');
  await writeFile(file, lines.map(l => `${JSON.stringify(l)}\n`).join(''));
  return {dir, file};
}

const T = (s: number) => new Date(Date.UTC(2026, 9, 2, 0, 0, s)).toISOString();

describe('会話記録 (シナリオ 33、34、45)', () => {
  it('指示、権限待ちの道具、最後の応答、時刻を読む', async () => {
    const {dir, file} = await transcriptDir([
      {type: 'user', timestamp: T(1), message: {content: 'old prompt'}},
      {type: 'assistant', timestamp: T(2), message: {content: [{type: 'text', text: 'old answer'}]}},
      {type: 'user', timestamp: T(10), message: {content: 'run the build'}},
      {
        type: 'assistant',
        timestamp: T(12),
        message: {content: [{type: 'tool_use', id: 'tu1', name: 'Bash', input: {command: 'npm run build'}}]},
      },
    ]);
    const tr = new Transcripts(dir);
    const f = await tr.read('sid-1');
    expect(f?.prompt?.text).toBe('run the build');
    expect(f?.permission).toBe('Bash: npm run build');
    expect(f?.haltAt).toBe(Date.parse(T(12)));
    expect(f?.lastText).toBeUndefined();

    // 断ったターン(45)
    await writeFile(
      file,
      `${
        (await readFile(file, 'utf8')) +
        [
          {
            type: 'user',
            timestamp: T(14),
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu1',
                  content: "The user doesn't want to proceed with this tool use.",
                },
              ],
            },
          },
          {
            type: 'user',
            timestamp: T(14),
            message: {content: [{type: 'text', text: '[Request interrupted by user for tool use]'}]},
          },
        ]
          .map(l => JSON.stringify(l))
          .join('\n')
      }\n`,
    );
    const g = await tr.read('sid-1');
    expect(g?.declined).toBe('Bash: npm run build');
    expect(g?.permission).toBeUndefined();
    expect(g?.prompt?.text).toBe('run the build');
    expect(await tr.firstPrompt('sid-1')).toBe('old prompt');
  });

  it('失敗の行と質問', async () => {
    const {dir} = await transcriptDir([
      {type: 'user', timestamp: T(1), message: {content: 'hi'}},
      {
        type: 'assistant',
        timestamp: T(2),
        isApiErrorMessage: true,
        message: {content: [{type: 'text', text: 'API Error: model not found'}]},
      },
    ]);
    expect((await new Transcripts(dir).read('sid-1'))?.error).toBe('API Error: model not found');
    const q = await transcriptDir([
      {type: 'user', timestamp: T(1), message: {content: 'hi'}},
      {
        type: 'assistant',
        timestamp: T(2),
        message: {
          content: [
            {type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: {questions: [{question: 'Which one?'}]}},
          ],
        },
      },
    ]);
    const f = await new Transcripts(q.dir).read('sid-1');
    expect(f?.question).toBe('Which one?');
    expect(f?.permission).toBeUndefined();
  });

  it('ファイルがなければ undefined で、あとからできれば読む', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wn-tr-'));
    const tr = new Transcripts(dir);
    expect(await tr.read('nope')).toBeUndefined();
    expect(await tr.firstPrompt('nope', true)).toBeUndefined();
    await mkdir(join(dir, 'projects', 'p'), {recursive: true});
    await writeFile(
      join(dir, 'projects', 'p', 'nope.jsonl'),
      `${JSON.stringify({type: 'user', timestamp: T(1), message: {content: 'late'}})}\n`,
    );
    expect(await tr.firstPrompt('nope', true)).toBe('late');
  });
});

describe('状態のファイル', () => {
  it('書いて読み戻す。壊れたファイルや違う版は空として読む', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wn-st-'));
    const path = statePath({XDG_STATE_HOME: dir}, 'wn-test');
    expect(path).toBe(join(dir, 'whatnext', 'state-wn-test.json'));
    expect(statePath({XDG_STATE_HOME: dir}, 'whatnext')).toBe(join(dir, 'whatnext', 'state.json'));
    const w = new StateWriter(path);
    await w.save({holds: new Map([['a', 'later']]), waits: new Map([['b', ['c']]])});
    const back = await loadState(path);
    expect([...back.holds]).toEqual([['a', 'later']]);
    expect([...back.waits]).toEqual([['b', ['c']]]);
    await writeFile(path, '{broken');
    expect((await loadState(path)).holds.size).toBe(0);
    await writeFile(path, JSON.stringify({version: 2, holds: {a: ''}}));
    expect((await loadState(path)).holds.size).toBe(0);
  });
});
