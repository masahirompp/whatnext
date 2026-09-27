import {describe, expect, it} from 'vitest';
import {bangCommands, stripComment} from './model.js';
import {summarize} from './transcript.js';
import {rowStatus} from './status.js';
import type {SessionEvents} from './receiver.js';

describe('bangCommands', () => {
	it('picks `! ` lines in fenced code blocks, in order, without trailing comments', () => {
		const text = [
			'publish の手順は前回と同じです。',
			'',
			'```',
			'! npm version minor   # 0.2.0 のコミットとタグを作る',
			'! npm publish',
			'!  git push --follow-tags  # push',
			'```',
		].join('\n');
		expect(bangCommands(text)).toEqual(['npm version minor', 'npm publish', 'git push --follow-tags']);
	});

	it('picks inline code `! cmd` outside code blocks', () => {
		expect(bangCommands('sandbox で弾かれたので `! touch ~/x` を打ってください。`ls` は不要。')).toEqual(['touch ~/x']);
	});

	it('ignores plain-text ! and code block lines not starting with `! `', () => {
		const text = ['すごい! ! これは地の文', '```sh', 'echo hi!', '!ls', '$ ! npm login', '```'].join('\n');
		expect(bangCommands(text)).toEqual([]);
	});

	it('ignores commands with control characters', () => {
		expect(bangCommands('```\n! rm -rf \x1b[2J\n! ok\x07\n! echo fine\n```')).toEqual(['echo fine']);
		expect(bangCommands('`! a\tb`')).toEqual([]);
	});

	it('keeps a single-space # (URLs, anchors)', () => {
		expect(stripComment('open https://x.test/a #frag')).toBe('open https://x.test/a #frag');
		expect(stripComment('npm version minor   # note')).toBe('npm version minor');
		expect(bangCommands('```\n! curl https://x.test/#top\n```')).toEqual(['curl https://x.test/#top']);
	});

	it('handles ~~~ fences and indented fences, and code in fences is not inline', () => {
		const text = ['  ```bash', '  ! npm login', '  ```', '~~~', '! docker compose up', '~~~', 'then `! npm login` again'].join('\n');
		expect(bangCommands(text)).toEqual(['npm login', 'docker compose up']);
	});

	it('returns nothing for empty input', () => {
		expect(bangCommands(undefined)).toEqual([]);
		expect(bangCommands('```\n! \n!   # only a note\n```')).toEqual([]);
	});
});

const T0 = Date.parse('2026-09-27T10:00:00.000Z');
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const row = (o: any) => JSON.stringify({isSidechain: false, uuid: `u${Math.random()}`, ...o});
const user = (s: number, content: any, extra: any = {}) => row({type: 'user', timestamp: iso(s), message: {role: 'user', content}, ...extra});
const asst = (s: number, content: any[], extra: any = {}) =>
	row({type: 'assistant', timestamp: iso(s), message: {id: extra.mid ?? `m${s}`, role: 'assistant', content}, ...extra});

describe('summarize (transcript)', () => {
	it('finds the last prompt, the answer and the last row time', () => {
		const lines = [
			user(0, 'first'),
			asst(1, [{type: 'text', text: 'old answer'}]),
			user(10, 'publish it'),
			asst(11, [{type: 'thinking', thinking: '...'}], {mid: 'a'}),
			asst(12, [{type: 'tool_use', id: 't1', name: 'Bash', input: {command: 'npm publish'}}], {mid: 'a'}),
			user(13, [{type: 'tool_result', tool_use_id: 't1', content: 'EPERM'}]),
			asst(14, [{type: 'text', text: 'Run this:\n```\n! npm publish\n```'}], {mid: 'b'}),
			row({type: 'system', subtype: 'turn_duration', timestamp: iso(15)}),
		];
		const {info, sawPrompt} = summarize(lines);
		expect(sawPrompt).toBe(true);
		expect(info.prompt).toEqual({at: T0 + 10000, text: 'publish it'});
		expect(info.answer?.text).toContain('! npm publish');
		expect(info.pendingTool).toBeUndefined();
		expect(info.lastAt).toBe(T0 + 14000);
	});

	it('reports a tool_use without result as pending, and no answer', () => {
		const {info} = summarize([
			user(0, 'write outside'),
			asst(1, [{type: 'text', text: 'I will write the file.'}], {mid: 'a'}),
			asst(2, [{type: 'tool_use', id: 't1', name: 'Bash', input: {command: 'date > /x'}}], {mid: 'a'}),
		]);
		expect(info.pendingTool).toMatchObject({tool: 'Bash', input: {command: 'date > /x'}, at: T0 + 2000});
		expect(info.answer).toBeUndefined();
		expect(info.lastText?.text).toBe('I will write the file.');
	});

	it('skips meta rows, local command output, bash rows, sidechains and interruption marks as prompts', () => {
		const {info} = summarize([
			user(0, 'real prompt'),
			user(1, '<local-command-stdout>ok</local-command-stdout>'),
			user(2, '<bash-input>ls</bash-input>'),
			user(3, 'caveat', {isMeta: true}),
			user(4, 'sub prompt', {isSidechain: true}),
			user(5, [{type: 'text', text: '[Request interrupted by user for tool use]'}]),
		]);
		expect(info.prompt?.text).toBe('real prompt');
	});

	it('cleans slash command prompts', () => {
		const {info} = summarize([user(0, '<command-message>x</command-message>\n<command-name>/review</command-name>\n<command-args>12</command-args>')]);
		expect(info.prompt?.text).toBe('/review 12');
	});

	it('takes the API error row as the failure', () => {
		const {info} = summarize([
			user(0, 'hi'),
			asst(1, [{type: 'text', text: "There's an issue with the selected model (x)."}], {isApiErrorMessage: true}),
		]);
		expect(info.error).toEqual({at: T0 + 1000, text: "There's an issue with the selected model (x)."});
		expect(info.answer).toBeUndefined();
	});

	it('tolerates broken lines', () => {
		const {info, sawPrompt} = summarize(['{broken', user(0, 'ok')]);
		expect(sawPrompt).toBe(true);
		expect(info.prompt?.text).toBe('ok');
	});
});

const ev = (e: Partial<SessionEvents>): SessionEvents => ({count: 0, prompts: 0, ...e});

describe('rowStatus', () => {
	const tr = summarize([
		user(10, 'publish it'),
		asst(20, [{type: 'text', text: 'Done.\n```\n! npm publish  # otp\n```'}]),
	]).info;

	it('uses the transcript when there are no hooks (external session)', () => {
		expect(rowStatus('Review', undefined, tr)).toEqual({note: 'Done.', since: T0 + 20000, bang: ['npm publish']});
	});

	it('uses the transcript prompt for a working row', () => {
		const t = summarize([user(10, 'fix the bug\nplease')]).info;
		expect(rowStatus('Working', undefined, t)).toEqual({note: '→ fix the bug', since: T0 + 10000, bang: []});
	});

	it('prefers hooks of the current turn', () => {
		const e = ev({prompt: {at: T0 + 10001, text: 'publish it'}, stop: {at: T0 + 30000, message: 'Hook answer.'}});
		expect(rowStatus('Review', e, tr)).toEqual({note: 'Hook answer.', since: T0 + 30000, bang: []});
	});

	it('falls back per item: hooks missed the prompt (whatnext reopened mid-turn) but got the Stop', () => {
		const e = ev({stop: {at: T0 + 30000, message: 'Hook answer.'}});
		expect(rowStatus('Review', e, tr).note).toBe('Hook answer.');
	});

	it('ignores hook values of a previous turn and uses the transcript (whatnext was closed)', () => {
		const e = ev({prompt: {at: T0 - 50000, text: 'old'}, stop: {at: T0 - 40000, message: 'Old answer.'}});
		expect(rowStatus('Review', e, tr)).toEqual({note: 'Done.', since: T0 + 20000, bang: ['npm publish']});
	});

	it('ignores a transcript that has not caught up with the hooked prompt', () => {
		const e = ev({prompt: {at: T0 + 60000, text: 'next task'}});
		expect(rowStatus('Working', e, tr)).toEqual({note: '→ next task', since: T0 + 60000, bang: []});
	});

	it('shows no `!` line once the next instruction is sent', () => {
		const t = summarize([
			user(10, 'publish it'),
			asst(20, [{type: 'text', text: '`! npm publish`'}]),
			user(30, 'thanks, now tag it'),
		]).info;
		expect(rowStatus('Working', undefined, t).bang).toEqual([]);
	});

	it('permission and question from a pending tool_use', () => {
		const p = summarize([user(0, 'go'), asst(3, [{type: 'tool_use', id: 't', name: 'Bash', input: {command: 'date > /x\nmore'}}])]).info;
		expect(rowStatus('Permission', undefined, p)).toEqual({note: 'Bash: date > /x', since: T0 + 3000, bang: []});
		const q = summarize([
			user(0, 'go'),
			asst(4, [{type: 'tool_use', id: 't', name: 'AskUserQuestion', input: {questions: [{question: 'Which one?'}]}}]),
		]).info;
		expect(rowStatus('Question', undefined, q)).toEqual({note: 'Which one?', since: T0 + 4000, bang: []});
	});

	it('failure from the API error row', () => {
		const f = summarize([user(0, 'hi'), asst(1, [{type: 'text', text: 'Model not found.'}], {isApiErrorMessage: true})]).info;
		expect(rowStatus('Failed', undefined, f)).toEqual({note: 'Model not found.', since: T0 + 1000, bang: []});
	});

	it('does not use a partial answer of a turn still in progress', () => {
		expect(rowStatus('Working', undefined, tr).bang).toEqual([]);
	});

	it('failure from StopFailure shows the message, not the error code (same as the transcript)', () => {
		const msg = "There's an issue with the selected model (x). It may not exist.";
		const e = ev({prompt: {at: T0, text: 'hi'}, failure: {at: T0 + 1000, error: 'model_not_found', message: msg}});
		expect(rowStatus('Failed', e, undefined).note).toBe(msg);
		const f = summarize([user(0, 'hi'), asst(1, [{type: 'text', text: msg}], {isApiErrorMessage: true})]).info;
		expect(rowStatus('Failed', undefined, f).note).toBe(msg);
		const codeOnly = ev({failure: {at: T0 + 1000, error: 'model_not_found'}});
		expect(rowStatus('Failed', codeOnly, undefined).note).toBe('model_not_found');
	});

	it('nothing at all → nothing', () => {
		expect(rowStatus('Question', undefined, undefined)).toEqual({note: undefined, since: undefined, bang: []});
	});
});
