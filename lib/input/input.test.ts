import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseAgents, parseUsage} from './claude.js';
import {HookStore, supplement} from './hooks.js';
import {parseParents} from './procs.js';
import {launchSettings} from './receiver.js';
import {instructionText, leadLine, promptLine, toolTarget} from './text.js';
import {Transcripts} from './transcript.js';

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

  describe('貼り付けで始めた指示 (#291)', () => {
    // 観測した4つの形(claude-code-behavior.md「会話記録」の貼り付け。会話記録とフックの prompt は同じ文字列)
    const pasteOnly =
      '\n\n<pasted_content id="921c">\ncycle-rewrite の実装セッションとして、サイクル9を実装する。\n手順は次のとおり。\n</pasted_content id="921c">\n';
    const textThenPaste =
      'このログを見て \n\n<pasted_content id="5e0a">\nError: boom\n    at main\n</pasted_content id="5e0a">\n';
    const shortPaste = '別のセッションの記録を読んで、指摘を直して:';
    const pasteThenText =
      '\n\n<pasted_content id="7b3f">\nError: boom\n    at main\n</pasted_content id="7b3f">\n\nこのエラーを直して。CI だけで落ちる\n2行目';
    const cases: [string, string][] = [
      [pasteOnly, 'cycle-rewrite の実装セッションとして、サイクル9を実装する。'],
      [textThenPaste, 'このログを見て'],
      [shortPaste, '別のセッションの記録を読んで、指摘を直して:'],
      [pasteThenText, 'このエラーを直して。CI だけで落ちる'],
    ];

    it('タグの外の自分の文、なければ最初の貼り付けの中身の最初の行。タグがなければ今のまま', () => {
      for (const [s, want] of cases) expect(promptLine(s)).toBe(want);
    });

    it('会話記録の指示とフックの prompt で同じになる', () => {
      for (const [s, want] of cases) {
        expect(instructionText(s)).toBe(want);
        const store = new HookStore(() => 1);
        store.receiveHook({session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: s});
        expect(store.get('s')?.prompt?.text).toBe(want);
      }
    });

    it('貼り付けが複数あっても、外に文がなければ最初の貼り付けの中身', () => {
      expect(
        promptLine(
          '\n\n<pasted_content id="a">\nfirst\n</pasted_content id="a">\n\n<pasted_content id="b">\nsecond\n</pasted_content id="b">\n',
        ),
      ).toBe('first');
    });

    it('中身が空の行だけでも指示に数え、空の一言にする', () => {
      const blank = '\n\n<pasted_content id="aa">\n\n\n</pasted_content id="aa">\n';
      expect(promptLine(blank)).toBe('');
      expect(instructionText(blank)).toBe('');
    });

    it('中身に別の id の閉じるタグがあっても、貼り付けは同じ id の閉じるタグまで続く', () => {
      // Claude Code は中身をそのままタグの間に入れるとみなす(タグを含む中身は確かめていない)
      const s =
        '\n\n<pasted_content id="921c">\nテストの見本を直す。\nconst s = \'</pasted_content id="zz">\';\n内側の残りの行\n</pasted_content id="921c">\n';
      expect(promptLine(s)).toBe('テストの見本を直す。');
      expect(instructionText(s)).toBe('テストの見本を直す。');
    });
  });

  it('道具と対象', () => {
    expect(toolTarget('Bash', {command: 'npm test\nmore'})).toBe('Bash: npm test');
    expect(toolTarget('Edit', {file_path: '/a/b.ts'})).toBe('Edit: /a/b.ts');
    expect(toolTarget('Foo', {})).toBe('Foo');
    // 決めた項目がなければ入力の最初の文字列(#266)
    expect(toolTarget('mcp__slack__send', {channel: 'C012AB', count: 3, text: 'hi'})).toBe('mcp__slack__send: C012AB');
    expect(toolTarget('mcp__x__y', {n: 1})).toBe('mcp__x__y');
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

  it('会話記録の指示はフックの指示の2秒前まで同じターンとみなし、フックの値はフックの指示より後だけ(#267)', () => {
    let t = 10000;
    const store = new HookStore(() => t);
    store.receiveHook({session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'next'});
    const tr = (at: number) => ({prompt: {text: 'next', at}, lastText: 'from transcript', haltAt: at + 500});
    expect(supplement(store.get('s'), tr(8000), undefined).lastText).toBe('from transcript');
    expect(supplement(store.get('s'), tr(7999), undefined).lastText).toBeUndefined();
    // フックの指示より前の Stop は前のターン
    t = 9500;
    store.receiveHook({session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'prev answer'});
    expect(supplement(store.get('s'), undefined, undefined).lastText).toBeUndefined();
  });

  const notification =
    '<task-notification>\n<task-id>bq1x2y3z4</task-id>\n<tool-use-id>toolu_01AbCdEf</tool-use-id>\n<status>completed</status>\n</task-notification>';

  it('指示でない prompt(タスクの通知)は前の指示を残し、前のターンの終わりの値は消す(#361)', () => {
    let t = 1000;
    const store = new HookStore(() => t);
    store.receiveHook({session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'run the tests in background'});
    t = 2000;
    store.receiveHook({session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'Started.'});
    t = 3000;
    store.receiveHook({session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: notification});
    expect(store.get('s')).toEqual({prompt: {text: 'run the tests in background', at: 1000}, turnAt: 3000});
    const s = supplement(store.get('s'), undefined, undefined);
    expect(s.prompt).toEqual({text: 'run the tests in background', at: 1000});
    expect(s.lastText).toBeUndefined();
    expect(s.haltAt).toBeUndefined();
  });

  it('通知で始まったターンで権限を断ったら、前のターンの質問ではなく断った道具を出す(#361)', () => {
    let t = 1000;
    const store = new HookStore(() => t);
    store.receiveHook({session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'ask me which db to use'});
    t = 2000;
    store.receiveHook({
      session_id: 's',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_q',
      tool_input: {questions: [{question: 'Which database?'}]},
    });
    t = 5000;
    store.receiveHook({session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'Using Postgres.'});
    t = 60000;
    store.receiveHook({session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: notification});
    t = 61000;
    store.receiveHook({
      session_id: 's',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: {command: 'rm -rf build', description: 'Remove build'},
    });
    // 断ると Stop は来ない。会話記録の最後の指示は通知より前なので、その値も使わない
    const tr = {
      prompt: {text: 'ask me which db to use', at: 1000},
      question: 'Which database?',
      lastText: 'Using Postgres.',
    };
    for (const s of [supplement(store.get('s'), undefined, undefined), supplement(store.get('s'), tr, undefined)]) {
      expect(s.prompt).toEqual({text: 'ask me which db to use', at: 1000});
      expect(s.question).toBeUndefined();
      expect(s.lastText).toBeUndefined();
      expect(s.declined).toBe('Bash: rm -rf build');
      expect(s.haltAt).toBe(61000);
    }
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
    await mkdir(join(dir, 'projects', 'p'), {recursive: true});
    await writeFile(
      join(dir, 'projects', 'p', 'nope.jsonl'),
      `${JSON.stringify({type: 'user', timestamp: T(1), message: {content: 'late'}})}\n`,
    );
    expect((await tr.read('nope'))?.prompt?.text).toBe('late');
  });

  it('作った時刻は、時刻を持つ最初の行の時刻。なければ undefined で、あとから書かれれば読み直す', async () => {
    const {dir, file} = await transcriptDir([
      {type: 'mode', mode: 'default'},
      {type: 'queue-operation', timestamp: T(3)},
      {type: 'user', timestamp: T(5), message: {content: 'hi'}},
    ]);
    const tr = new Transcripts(dir);
    expect(await tr.createdAt('sid-1')).toBe(Date.parse(T(3)));
    await writeFile(file, `${JSON.stringify({type: 'user', timestamp: T(9), message: {content: 'x'}})}\n`);
    expect(await tr.createdAt('sid-1')).toBe(Date.parse(T(3)));
    const none = await transcriptDir([{type: 'mode', mode: 'default'}]);
    const tr2 = new Transcripts(none.dir);
    expect(await tr2.createdAt('sid-1')).toBeUndefined();
    // 大きさが変わらなければ読み直さない
    expect(await tr2.createdAt('sid-1')).toBeUndefined();
    await writeFile(none.file, `${JSON.stringify({type: 'user', timestamp: T(7), message: {content: 'x'}})}\n`);
    expect(await tr2.createdAt('sid-1')).toBe(Date.parse(T(7)));
  });
});

describe('プロセス表', () => {
  it('ps の出力を読む', () => {
    expect([...parseParents('    1     0\n  320     1\n 4410   320\n')]).toEqual([
      [1, 0],
      [320, 1],
      [4410, 320],
    ]);
  });
});
