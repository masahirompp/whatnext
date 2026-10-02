import {describe, expect, it} from 'vitest';
import {classify, dedupe, type AgentRow} from './agents.js';
import {filterCands, labelsFor} from './candidates.js';
import {ATTACH_HELP} from './keys.js';
import {canWaitFor, deriveTiers, layout, type Ranked} from './model.js';
import {formatWait, headOf} from './text.js';
import {parseUsage} from './usage.js';

const row = (o: Partial<AgentRow>): AgentRow => ({kind: 'background', sessionId: 's', cwd: '/r', ...o});

describe('段の判定(シナリオ 4)', () => {
	it('waitingFor を最優先にする', () => {
		expect(classify(row({state: 'working', status: 'waiting', waitingFor: 'permission prompt', pid: 1}))?.tier).toBe('permission');
		expect(classify(row({waitingFor: 'dialog open', pid: 1}))).toEqual({tier: 'question', reason: 'dialog open'});
	});
	it('pid のない blocked は失敗、working+idle は質問待ち、stopped は停止', () => {
		expect(classify(row({state: 'blocked'}))).toEqual({tier: 'failed', reason: 'no process'});
		expect(classify(row({state: 'working', status: 'idle', pid: 1}))?.tier).toBe('question');
		expect(classify(row({state: 'stopped'}))?.tier).toBe('stopped');
	});
	it('interactive の idle は対象外', () => {
		expect(classify(row({kind: 'interactive', status: 'idle', pid: 1}))).toBeNull();
	});
	it('重複は pid を持つ行を採る', () => {
		const rows = dedupe([row({sessionId: 'x', state: 'done'}), row({sessionId: 'x', kind: 'interactive', status: 'busy', pid: 3})]);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.kind).toBe('interactive');
	});
});

describe('並びと待ち先(シナリオ 3、17〜20)', () => {
	const mk = (sid: string, own: Ranked['own'], since: number | null): Ranked => ({sid, name: sid, own, since});
	it('待機時間が分からない行は同じ段の先頭', () => {
		const v = new Map([mk('a', 'review', 100), mk('b', 'review', null)].map(s => [s.sid, s]));
		const l = layout(v, deriveTiers(v, new Map()), new Map(), new Set(), undefined);
		expect(l.ladder.map(n => n.s.sid)).toEqual(['b', 'a']);
	});
	it('待ち先が稼働中なら待ち元は待ち。組は待ち先の位置に出る', () => {
		const v = new Map([mk('p', 'review', 1), mk('c', 'permission', 5), mk('x', 'question', 2)].map(s => [s.sid, s]));
		const waits = new Map([['p', new Set(['c'])]]);
		const tiers = deriveTiers(v, waits);
		expect(tiers.get('p')).toBe('waiting');
		const l = layout(v, tiers, waits, new Set(), undefined);
		expect(l.ladder.map(n => n.rowPrefix + n.s.sid)).toEqual(['p', '└ c', 'x']);
	});
	it('一周する待ち先は結べない', () => {
		const waits = new Map([['a', new Set(['b'])]]);
		expect(canWaitFor(waits, 'b', 'a')).toBe(false);
	});
});

describe('一言(シナリオ 39)', () => {
	it('区切り線と記号を飛ばす', () => {
		expect(headOf('---\n- **変更点**は3つです')).toBe('変更点は3つです');
		expect(headOf('```\nnpm test\n```')).toBe('npm test');
	});
	it('1分未満は <1m', () => {
		expect(formatWait(30_000)).toBe('<1m');
		expect(formatWait(null)).toBe('-');
	});
});

describe('その他', () => {
	it('Usage の行を読む', () => {
		const now = new Date(2026, 8, 25);
		expect(parseUsage('Current session: 42% used · resets Sep 25 at 2:09pm (Asia/Tokyo)', now)).toEqual([{label: 'session', percent: 42, resets: '2:09pm'}]);
	});
	it('同じ名前の候補だけ親を足す', () => {
		expect(labelsFor(['/a/foo', '/b/foo', '/c/bar']).map(c => c.label)).toEqual(['a/foo', 'b/foo', 'bar']);
		expect(filterCands(labelsFor(['/x/whatnext', '/y/app']), 'wn').map(c => c.label)).toEqual(['whatnext']);
	});
	it('キーの説明は ctrl を押したままの形で、よく使うものが先', () => {
		expect(ATTACH_HELP.startsWith('^Q^L back · ^Q^J next · ^Q^W workbench')).toBe(true);
		expect(ATTACH_HELP).toContain('^Q^F wait');
		expect(ATTACH_HELP).not.toContain('^Q^Q');
	});
});
