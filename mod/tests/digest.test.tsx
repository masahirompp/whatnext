import type {On, SessionMessage} from 'claude-code';
import type {Engine} from 'claude-code/testing';
import {expect, test} from 'claude-code/testing';
import {DIGEST_SYSTEM, digestPrompt, instructionsOf, languageOf, languageOfOne, parseDigest} from '../hooks/digest';
import {addLinks, linkOf, urlsIn} from '../hooks/links';

// Run with `npm run test:mod` (`claude plugin test mod`). The engine's hooks below stand for Claude Code.

const PANE = {
  plugin: 'whatnext-digest',
  component: 'Pane',
  requestId: 'whatnext-digest',
  props: {
    title: 'Digest',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: {offset: 0, bodyRows: 40},
    view: {},
  },
} as const;

declare function setTimeout(fn: () => void, ms: number): unknown;
const settle = () => new Promise<void>(r => setTimeout(r, 300));
const usage = {input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};

interface Posted {
  url: string;
  body: Record<string, unknown>;
}

/** The engine beneath the mod: `history` the conversation, `answer` what Haiku says, posts kept in `posted`. */
function engine(
  on: On,
  opts: {
    history?: () => readonly SessionMessage[];
    answer?: string;
    port?: string;
    asks?: string[];
    /**
     * What the session of whatnext's list holds in `@wn_digest_port` (the port it takes digests on); null when no server or list,
     * an Error when tmux cannot start.
     */
    live?: () => string | null | Error;
    checks?: string[][];
  } = {},
): Posted[] {
  const posted: Posted[] = [];
  const vars: Record<string, string | undefined> = {
    WHATNEXT_DIGEST_PORT: opts.port,
    WHATNEXT_DIGEST_TMUX: '/opt/tmux',
    WHATNEXT_DIGEST_SOCKET: '/tmp/tmux-501/whatnext',
  };
  on('session.messages', () => ({value: (opts.history?.() ?? []) as SessionMessage[]}));
  on('session.id', () => ({value: 'sid-1'}));
  on('env.get', (_, e) => ({value: vars[e.name]}));
  on('process.run', (_, e) => {
    opts.checks?.push([...e.argv]);
    const live = opts.live ? opts.live() : (opts.port ?? '14318');
    if (live instanceof Error) throw live;
    const cut = {isStdoutTruncated: false, isStderrTruncated: false};
    if (live === null) return {value: {exitCode: 1, stdout: '', stderr: 'no server running', ...cut}};
    return {value: {exitCode: 0, stdout: `${live}\n`, stderr: '', ...cut}};
  });
  on('model.complete', (_, e) => {
    opts.asks?.push(String(e.prompt));
    if (opts.answer === undefined || e.system !== DIGEST_SYSTEM) {
      return {value: {isAnswered: false, reason: 'aborted', usage}};
    }
    return {value: {isAnswered: true, text: opts.answer, usage}};
  });
  on('http.fetch', (_, e) => {
    posted.push({url: e.url, body: JSON.parse(String(e.init?.body ?? '{}'))});
    return {value: {status: 204, ok: true, headers: {}, text: ''}};
  });
  on('ui.open', () => ({value: {isPlaced: true}}));
  on('command.register', () => ({value: {command: 'wn-digest'}}));
  on('session.start', (_, e) => ({cwd: e.cwd}));
  on('turn.start', (_, e) => ({turnId: e.turnId}));
  on('turn.complete', () => ({text: ''}));
  return posted;
}

async function turn($: Engine, prompt: string, answer: string, id = 't1'): Promise<void> {
  await $.turn.start({text: prompt, turnId: id});
  await $.turn.complete({answer, durationMs: 10, isAborted: false, turnId: id, reason: 'answer'} as never);
  await settle();
}

test('at a turn end the digest and the links go to whatnext, on the port whatnext gave', async ($, on) => {
  const instructions: SessionMessage[] = [{role: 'user', text: 'ログイン画面の二重送信を直して', toolUses: []}];
  const posted = engine(on, {
    history: () => instructions,
    port: '14555',
    answer: '{"goal": "ログイン画面の二重送信を直す", "progress": "ボタンを無効にした", "next": "レビューを待つ"}',
  });
  await $.session.start({cwd: '/', surface: 'terminal', isInteractive: true});
  await turn($, 'ログイン画面の二重送信を直して', '直しました。[PR #58](https://github.com/acme/app/pull/58)');
  const last = posted.at(-1);
  expect(last?.url).toBe('http://127.0.0.1:14555/v1/hooks');
  expect(last?.body).toEqual({
    hook_event_name: 'WhatnextDigest',
    session_id: 'sid-1',
    digest: {goal: 'ログイン画面の二重送信を直す', progress: 'ボタンを無効にした', next: 'レビューを待つ'},
    links: [{label: 'PR #58', href: 'https://github.com/acme/app/pull/58'}],
  });
});

test('with no port given it posts to 14318; a failed model call still sends the links', async ($, on) => {
  const posted = engine(on, {history: () => [{role: 'user', text: 'x', toolUses: []}]});
  await $.session.start({cwd: '/', surface: 'terminal', isInteractive: true});
  await turn($, 'see https://github.com/acme/app/issues/412', 'ok');
  expect(posted.at(-1)?.url).toBe('http://127.0.0.1:14318/v1/hooks');
  expect(posted.at(-1)?.body.digest).toBe(null);
  expect(posted.at(-1)?.body.links).toEqual([{label: 'acme/app#412', href: 'https://github.com/acme/app/issues/412'}]);
});

test('the next digest reads the previous one, the instructions and the last answer', async ($, on) => {
  const asks: string[] = [];
  const history: SessionMessage[] = [
    {role: 'user', text: '認証をトークン方式へ移して', toolUses: []},
    {role: 'assistant', text: '半分移しました', toolUses: []},
  ];
  engine(on, {history: () => history, asks, answer: '{"goal": "認証を移す", "progress": "半分", "next": "admin"}'});
  await $.session.start({cwd: '/', surface: 'terminal', isInteractive: true});
  await turn($, '認証をトークン方式へ移して', '半分移しました');
  history.push({role: 'user', text: 'admin 配下も', toolUses: []});
  await turn($, 'admin 配下も', '移しました', 't2');
  expect(asks.at(-1)).toContain('## Previous digest');
  expect(asks.at(-1)).toContain('"goal":"認証を移す"');
  expect(asks.at(-1)).toContain('- admin 配下も');
  expect(asks.at(-1)).toContain('移しました');
  expect(asks.at(-1)).toContain('## Language\nWrite goal, progress and next in Japanese');
});

test('the pane draws Goal, Progress, Next and the links under the same headings as the list', async ($, on) => {
  engine(on, {
    history: () => [{role: 'user', text: 'x', toolUses: []}],
    answer: '{"goal": "G", "progress": "N", "next": "X"}',
  });
  await $.session.start({cwd: '/', surface: 'terminal', isInteractive: true});
  await turn($, 'x', 'https://github.com/acme/app/commit/3f2a91c0aa');
  const ui = await $.ui.mount({...PANE, surface: 'terminal'});
  for (const t of [/^Goal$/, /^Progress$/, /^Next$/, /^Links$/, /^G$/, /^N$/, /^X$/]) {
    expect(await ui.find({type: 'Text', text: t})).toBeTruthy();
  }
  expect((await ui.findAll({type: 'Link'})).map(l => l.props.href)).toEqual([
    'https://github.com/acme/app/commit/3f2a91c0aa',
  ]);
  await ui.unmount();
});

test('before the first turn ends the pane says no digest yet', async ($, on) => {
  engine(on);
  await $.session.start({cwd: '/', surface: 'terminal', isInteractive: true});
  const ui = await $.ui.mount({...PANE, surface: 'terminal'});
  expect(await ui.find({type: 'Text', text: /No digest yet/})).toBeTruthy();
  await ui.unmount();
});

test('the digest is parsed from JSON, cut to its lengths, and none when it is empty or not JSON', () => {
  expect(parseDigest('```json\n{"goal": "a", "progress": "b", "next": ""}\n```')).toEqual({
    goal: 'a',
    progress: 'b',
    next: '',
  });
  expect(parseDigest('no json')).toBe(null);
  expect(parseDigest('{"goal": "", "progress": "", "next": ""}')).toBe(null);
  expect(parseDigest(`{"goal": "${'x'.repeat(200)}"}`)?.goal.length).toBe(80);
  expect(digestPrompt(null, ['a'], '')).not.toContain('Previous digest');
});

// The language of the digest is named from the person's instructions, not left to the model: told only "the
// language the user writes in", Haiku once answered an English instruction in Russian.

test('an instruction is Japanese when it has kana, English when its letters are all Latin', () => {
  expect(languageOfOne('ログイン画面の二重送信を直して')).toBe('Japanese');
  expect(languageOfOne('README.md に hello の行を足して')).toBe('Japanese');
  expect(languageOfOne('Fix the double submit on the login page')).toBe('English');
  expect(languageOfOne('see `ログイン()` and https://example.com/ログイン')).toBe('English');
  expect(languageOfOne('```\nエラー: 見つからない\n```\nwhy does this fail?')).toBe('English');
  expect(languageOfOne('/review')).toBe(undefined);
  expect(languageOfOne('/review この PR を見て')).toBe('Japanese');
  expect(languageOfOne('Исправь ошибку')).toBe(undefined);
  expect(languageOfOne('修复登录错误')).toBe(undefined);
  expect(languageOfOne('42')).toBe(undefined);
});

test("the instructions' language is the one most of them are in; on a tie, the newest one's", () => {
  expect(languageOf(['認証を移して', 'ok', 'admin 配下も'])).toBe('Japanese');
  expect(languageOf(['Move auth to tokens', 'はい'])).toBe('Japanese');
  expect(languageOf(['はい', 'Move auth to tokens'])).toBe('English');
  expect(languageOf(['/review', 'Move auth to tokens'])).toBe('English');
  expect(languageOf(['Исправь ошибку'])).toBe(undefined);
  expect(languageOf([])).toBe(undefined);
});

test('the input names the language to write in, and the system prompt points to it', () => {
  expect(DIGEST_SYSTEM).toContain('Write every value in the language the "## Language" part of the input names');
  expect(DIGEST_SYSTEM).not.toContain('the language the user writes in');
  const en = digestPrompt(
    {goal: 'Исправить вход', progress: '', next: ''},
    ['Fix the double submit on the login page'],
    'Done.',
  );
  expect(en.split('\n').slice(-2)).toEqual([
    '## Language',
    "Write goal, progress and next in English: the person's instructions are in English. Translate the previous digest into English if it is in another language.",
  ]);
  expect(digestPrompt(null, ['ログイン画面の二重送信を直して'], '')).toContain(
    "## Language\nWrite goal, progress and next in Japanese: the person's instructions are in Japanese.",
  );
  expect(digestPrompt(null, ['Исправь ошибку'], '').split('\n').at(-1)).toBe(
    "Write goal, progress and next in the language of the person's instructions above: in Japanese if they are in Japanese, in English if they are in English. Never use a language they are not written in.",
  );
});

// What is not an instruction (GLOSSARY.md "指示"), in the shapes `$.session.messages()` gave on Claude Code 2.1.330:
// a turn interrupted with Esc and one interrupted at a permission prompt, `/model haiku`, a plugin's slash command,
// and `/compact`.
const OBSERVED: SessionMessage[] = [
  {role: 'user', text: '認証をトークン方式へ移して', toolUses: []},
  {role: 'assistant', text: '# 移行の計画\n\n途中まで', toolUses: []},
  {role: 'user', text: '[Request interrupted by user]', toolUses: []},
  {role: 'user', text: 'admin 配下も', toolUses: []},
  {role: 'assistant', text: '', toolUses: [{} as never]},
  {role: 'user', text: '', toolUses: [], toolResults: [{} as never]},
  {role: 'user', text: '[Request interrupted by user for tool use]', toolUses: []},
  {
    role: 'user',
    text: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>',
    toolUses: [],
  },
  {
    role: 'user',
    text: '<local-command-stdout>Set model to `Haiku 5.5` and saved as your default for new sessions</local-command-stdout>',
    toolUses: [],
  },
  {
    role: 'user',
    text: '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 58 を見て</command-args>',
    toolUses: [],
  },
  {
    role: 'user',
    text: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary: the user asked to move the authentication to tokens.',
    toolUses: [],
  },
  {
    role: 'user',
    text: '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>',
    toolUses: [],
  },
  {
    role: 'user',
    text: '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>',
    toolUses: [],
  },
  {role: 'user', text: '<command-message>probe</command-message>\n<command-name>/probe</command-name>', toolUses: []},
];

test('interrupt marks, local commands and their output, and the compact summary are not instructions; a slash command is /name args', () => {
  expect(instructionsOf(OBSERVED)).toEqual([
    '認証をトークン方式へ移して',
    'admin 配下も',
    '/review PR 58 を見て',
    '/probe',
  ]);
});

test('only the instructions go to the model and name the language: English marks do not turn a Japanese digest English', async ($, on) => {
  const asks: string[] = [];
  engine(on, {history: () => OBSERVED, asks, answer: '{"goal": "G", "progress": "N", "next": "X"}'});
  await $.session.start({cwd: '/', surface: 'terminal', isInteractive: true});
  await turn($, 'x', 'ok');
  const ask = asks.at(-1) ?? '';
  const part = ask.split("## The person's instructions (oldest first)\n")[1]?.split('\n\n')[0] ?? '';
  expect(part.split('\n')).toEqual([
    '- 認証をトークン方式へ移して',
    '- admin 配下も',
    '- /review PR 58 を見て',
    '- /probe',
  ]);
  expect(ask).toContain('## Language\nWrite goal, progress and next in Japanese');
});

// The link rules, moved with links.ts from session-timeline.

test('URLs are cut where the text around them begins', () => {
  expect(urlsIn('PR は https://github.com/o/r/pull/51 です。')).toEqual(['https://github.com/o/r/pull/51']);
  expect(urlsIn('see [#44](https://github.com/o/r/issues/44).')).toEqual(['https://github.com/o/r/issues/44']);
  expect(urlsIn('(https://example.com/a_(b))')).toEqual(['https://example.com/a_(b)']);
  expect(urlsIn('"https://example.com/x",')).toEqual(['https://example.com/x']);
  expect(urlsIn('http://localhost:3000/ok')).toEqual(['http://localhost:3000/ok']);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a template a text holds, not a page to open
  expect(urlsIn('https://${host}/x and https://foo')).toEqual([]);
  expect(urlsIn('https://docs.example.com/a(下書き)')).toEqual(['https://docs.example.com/a']);
});

test('GitHub issues, PRs and commits are named by number however the URL goes on', () => {
  expect(linkOf('https://github.com/o/r/pull/51/files#diff-1')?.label).toBe('o/r#51');
  expect(linkOf('https://github.com/o/r/issues/44#issuecomment-1')?.kind).toBe('Issue');
  expect(linkOf('https://github.com/o/r/commit/e26d750abc')?.label).toBe('o/r@e26d750');
  expect(linkOf('https://github.com/o/r')?.kind).toBe('URL');
});

test('a link said again moves to the front; a Markdown link names it', () => {
  const one = addLinks(
    [],
    ['https://github.com/o/r/issues/1 と https://docs.example.com/a', 'https://github.com/o/r/pull/2'],
  );
  expect(one.map(l => l.label)).toEqual(['o/r#2', 'docs.example.com/a', 'o/r#1']);
  const two = addLinks(one, ['[the issue](https://github.com/o/r/issues/1)']);
  expect(two.map(l => l.text ?? l.label)).toEqual(['the issue', 'o/r#2', 'docs.example.com/a']);
});

test("a tool call's output is not listed; its URL argument is", async ($, on) => {
  const posted = engine(on, {history: () => [{role: 'user', text: 'x', toolUses: []}]});
  on('tool.call', (_, e) => ({text: e.tool === 'Bash' ? 'https://noise.example.com/z' : '', result: {}}));
  await $.session.start({cwd: '/', surface: 'terminal', isInteractive: true});
  await $.turn.start({text: 'x', turnId: 't1'});
  await $.tool.call({tool: 'Bash', command: 'gh pr list', tool_use_id: 'b1'});
  await $.tool.call({tool: 'WebFetch', url: 'https://docs.example.com/mods', prompt: 'read', tool_use_id: 'w1'});
  await $.turn.complete({answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer'} as never);
  await settle();
  expect(posted.at(-1)?.body.links).toEqual([{label: 'docs.example.com/mods', href: 'https://docs.example.com/mods'}]);
});

test('with no whatnext taking digests, a turn end calls no model and sends nothing; it resumes once one does', async ($, on) => {
  const asks: string[] = [];
  const checks: string[][] = [];
  let live: string | null = null;
  const posted = engine(on, {
    history: () => [{role: 'user', text: 'x', toolUses: []}],
    port: '15555',
    asks,
    checks,
    live: () => live,
    answer: '{"goal": "G", "progress": "N", "next": "X"}',
  });
  await $.session.start({cwd: '/', surface: 'terminal', isInteractive: true});
  // whatnext quit: its tmux server (or the session of its list) is gone
  await turn($, 'x', 'https://github.com/acme/app/pull/1');
  expect(checks.at(-1)).toEqual([
    '/opt/tmux',
    '-S',
    '/tmp/tmux-501/whatnext',
    'show-options',
    '-t',
    '=list:',
    '-qv',
    '@wn_digest_port',
  ]);
  // whatnext runs again, without --digest (the option unset), or takes digests on another port
  live = '';
  await turn($, 'x', 'ok', 't2');
  live = '14318';
  await turn($, 'x', 'ok', 't3');
  expect(asks).toEqual([]);
  expect(posted).toEqual([]);
  // the pane still keeps the links
  const ui = await $.ui.mount({...PANE, surface: 'terminal'});
  expect((await ui.findAll({type: 'Link'})).map(l => l.props.href)).toEqual(['https://github.com/acme/app/pull/1']);
  await ui.unmount();
  // whatnext runs with --digest again: the next turn end writes a digest and sends it
  live = '15555';
  await turn($, 'x', 'ok', 't4');
  expect(asks.length).toBe(1);
  expect(posted.at(-1)?.url).toBe('http://127.0.0.1:15555/v1/hooks');
  expect(posted.at(-1)?.body.digest).toEqual({goal: 'G', progress: 'N', next: 'X'});
});

test('a check that cannot run counts as no whatnext taking digests', async ($, on) => {
  const asks: string[] = [];
  const posted = engine(on, {
    history: () => [{role: 'user', text: 'x', toolUses: []}],
    asks,
    answer: '{"goal": "G"}',
    live: () => new Error('cannot start'),
  });
  await $.session.start({cwd: '/', surface: 'terminal', isInteractive: true});
  await turn($, 'x', 'ok');
  expect(asks).toEqual([]);
  expect(posted).toEqual([]);
});
