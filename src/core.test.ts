import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {classify, dedupe, type AgentRow} from './agents.js';
import {filterCands, labelsFor} from './candidates.js';
import {canWaitFor, deriveTiers, layout, type Ranked} from './model.js';
import {bangCommands, headOf} from './text.js';
import {readTranscript} from './transcript.js';
import {parseUsage} from './usage.js';
import {Store} from './store.js';
import {width} from './term.js';
import {frame} from './view.js';

const bg = (o: Partial<AgentRow>): AgentRow => ({kind: 'background', sessionId: o.id ?? 'x', cwd: '/r', ...o});

describe('段の判定(シナリオ 1, 4)', () => {
	it('waitingFor を最優先にする', () => {
		expect(classify(bg({state: 'blocked', status: 'waiting', waitingFor: 'permission prompt', pid: 1}))?.tier).toBe('permission');
		expect(classify({kind: 'interactive', sessionId: 'i', cwd: '/', status: 'waiting', waitingFor: 'permission prompt', pid: 1})?.tier).toBe('permission');
		expect(classify(bg({state: 'blocked', waitingFor: 'sandbox request', pid: 1}))?.tier).toBe('sandbox');
		expect(classify(bg({state: 'blocked', waitingFor: 'dialog open', pid: 1}))).toEqual({tier: 'question', reason: 'dialog open'});
	});
	it('pid のない blocked は失敗、pid のある blocked は生の値を添えて質問待ち', () => {
		expect(classify(bg({state: 'blocked'}))).toEqual({tier: 'failed', reason: 'no process'});
		expect(classify(bg({state: 'blocked', status: 'idle', pid: 1}))).toEqual({tier: 'question', reason: 'blocked'});
	});
	it('working + idle は質問待ち、stopped は停止の段、interactive の idle は対象外', () => {
		expect(classify(bg({state: 'working', status: 'idle', pid: 1}))?.tier).toBe('question');
		expect(classify(bg({state: 'working', status: 'busy', pid: 1}))?.tier).toBe('working');
		expect(classify(bg({state: 'done', status: 'idle', pid: 1}))?.tier).toBe('review');
		expect(classify(bg({state: 'stopped'}))).toEqual({tier: 'stopped'});
		expect(classify({kind: 'interactive', sessionId: 'i', cwd: '/', status: 'idle', pid: 1})).toBeNull();
	});
	it('重複は pid を持つ行を採る', () => {
		const rows = dedupe([
			bg({sessionId: 's', id: 's', state: 'done'}),
			{kind: 'interactive', sessionId: 's', cwd: '/', status: 'waiting', waitingFor: 'permission prompt', pid: 3},
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.kind).toBe('interactive');
	});
});

const r = (sid: string, own: Ranked['own'], since: number | null): Ranked => ({sid, name: sid, own, since});

describe('並び(シナリオ 1, 3)と待ち先(18〜21)', () => {
	it('段の順、同じ段では待機時間が分からないものが先、長く待っているものが先', () => {
		const vis = new Map([r('s', 'stopped', 1), r('a', 'review', 100), r('b', 'permission', 500), r('c', 'review', null), r('d', 'review', 50), r('w', 'working', 10)].map(x => [x.sid, x]));
		const l = layout(vis, deriveTiers(vis, new Map()), new Map(), new Set(), undefined);
		expect(l.ladder.map(n => n.s.sid)).toEqual(['b', 'c', 'd', 'a', 'w', 's']);
	});
	it('待ち先が終わっていなければ待ち元は待ち。組は組の中で最も上の行の位置に出る', () => {
		const vis = new Map([r('A', 'review', 100), r('B', 'permission', 900), r('C', 'question', 50)].map(x => [x.sid, x]));
		const waits = new Map([['A', new Set(['B'])]]);
		const tiers = deriveTiers(vis, waits);
		expect(tiers.get('A')).toBe('waiting');
		// 待ちの段は稼働中の下、停止の上
		const vis2 = new Map([r('A', 'review', 100), r('B', 'working', 900), r('W', 'working', 1), r('S', 'stopped', 1)].map(x => [x.sid, x]));
		const w2 = new Map([['A', new Set(['B'])]]);
		const l2 = layout(vis2, deriveTiers(vis2, w2), w2, new Set(), undefined);
		expect(l2.ladder.map(n => n.s.sid)).toEqual(['W', 'A', 'B', 'S']);
		const l = layout(vis, tiers, waits, new Set(), undefined);
		expect(l.ladder.map(n => n.s.sid)).toEqual(['A', 'B', 'C']);
		expect(l.ladder[1]!.rowPrefix).toBe('└ ');
	});
	it('待ち先がレビュー待ちか停止の段に入るか、一覧から消えていれば、待ち元は自分の段', () => {
		const vis = new Map([r('A', 'review', 100), r('B', 'review', 900), r('S', 'stopped', 10)].map(x => [x.sid, x]));
		expect(deriveTiers(vis, new Map([['A', new Set(['B'])]])).get('A')).toBe('review');
		expect(deriveTiers(vis, new Map([['A', new Set(['S'])]])).get('A')).toBe('review');
		expect(deriveTiers(vis, new Map([['A', new Set(['Z'])]])).get('A')).toBe('review');
	});
	it('待ち元が自分でも人の手が要る段なら、その段に出る', () => {
		const vis = new Map([r('A', 'question', 100), r('B', 'working', 900)].map(x => [x.sid, x]));
		expect(deriveTiers(vis, new Map([['A', new Set(['B'])]])).get('A')).toBe('question');
	});
	it('根を保留にすると組ごと保留の組に移り、途中の保留の行は組の位置に数えない', () => {
		const vis = new Map([r('A', 'review', 100), r('B', 'permission', 900), r('C', 'question', 50)].map(x => [x.sid, x]));
		const waits = new Map([['A', new Set(['B'])]]);
		const tiers = deriveTiers(vis, waits);
		expect(layout(vis, tiers, waits, new Set(['A']), undefined).hold.map(n => n.s.sid)).toEqual(['A', 'B']);
		expect(layout(vis, tiers, waits, new Set(['B']), undefined).ladder.map(n => n.s.sid)).toEqual(['C', 'A', 'B']);
	});
	it('一周する関係とほかの待ち元の待ち先は結べない', () => {
		const waits = new Map([['A', new Set(['B'])], ['B', new Set(['C'])]]);
		expect(canWaitFor(waits, 'C', 'A')).toBe(false);
		expect(canWaitFor(waits, 'D', 'B')).toBe(false);
		expect(canWaitFor(waits, 'A', 'B')).toBe(true);
		expect(canWaitFor(waits, 'A', 'D')).toBe(true);
	});
	it('Last attached の組は先頭に分かれる', () => {
		const vis = new Map([r('A', 'review', 100), r('B', 'permission', 900)].map(x => [x.sid, x]));
		const l = layout(vis, deriveTiers(vis, new Map()), new Map(), new Set(), 'A');
		expect(l.last.map(n => n.s.sid)).toEqual(['A']);
		expect(l.ladder.map(n => n.s.sid)).toEqual(['B']);
	});
});

describe('一言(シナリオ 39)と `!` のコマンド(36)', () => {
	it('区切り線や箇条書きの記号とバッククォートを除く', () => {
		expect(headOf('---\n\n- **Done**: fixed `foo`')).toBe('Done: fixed foo');
		expect(headOf('```\ncode\n```\nAfter the fence')).toBe('After the fence');
		expect(headOf('```sh\nnpm test\n```')).toBe('npm test');
		expect(headOf('| a | b |\n|---|---|\n## Heading')).toBe('Heading');
	});
	it('コードブロックの `! ` の行とインラインコードを拾い、行末の注釈を外す', () => {
		const text = 'Run these:\n```\n! npm version minor   # 0.2.0 のタグ\n! npm publish\nnot this\n```\nor `! git push --follow-tags` then. Wow! no.';
		expect(bangCommands(text)).toEqual(['npm version minor', 'npm publish', 'git push --follow-tags']);
		expect(bangCommands('```\n! curl https://x#frag # one space\n```')).toEqual(['curl https://x#frag # one space']);
		expect(bangCommands('`! echo \u0007bell`')).toEqual([]);
	});
});

describe('作業ディレクトリの候補', () => {
	it('同じ名前だけ親を足して区別する', () => {
		expect(labelsFor(['/a/foo', '/b/foo', '/c/bar']).map(c => c.label)).toEqual(['a/foo', 'b/foo', 'bar']);
	});
	it('表示名はとびとび、フルパスは続けて含むときだけ当たり、表示名の当たりが上', () => {
		const cands = labelsFor(['/x/whatnext', '/ghq/wnt/other', '/y/skills']);
		expect(filterCands(cands, 'wnt').map(c => c.label)).toEqual(['whatnext', 'other']);
	});
});

describe('Usage', () => {
	it('枠ごとの使用率とリセットの時刻を読み、今日なら日付を省く', () => {
		const text = 'Current session: 42% used · resets Sep 28 at 2:09pm (Asia/Tokyo)\nCurrent week (all models): 25% used · resets Sep 29 at 9:59am (Asia/Tokyo)';
		expect(parseUsage(text, new Date(2026, 8, 28))).toEqual([
			{label: 'session', percent: 42, resets: '2:09pm'},
			{label: 'week (all models)', percent: 25, resets: 'Sep 29 9:59am'},
		]);
	});
});

describe('会話記録の指示(シナリオ 33)', () => {
	it('ターンを始めるスラッシュコマンドは指示として `/名前 引数` にし、手元で完結するコマンドは数えない', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wn-'));
		mkdirSync(join(dir, 'projects', 'p'), {recursive: true});
		const line = (type: string, ts: string, content: unknown) => JSON.stringify({type, timestamp: ts, message: {role: type, content}});
		writeFileSync(
			join(dir, 'projects', 'p', 'slash.jsonl'),
			[
				line('user', '2026-09-28T01:00:00Z', 'fix the login bug'),
				line('assistant', '2026-09-28T01:01:00Z', [{type: 'text', text: 'Fixed.'}]),
				line('user', '2026-09-28T02:00:00Z', '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>12</command-args>'),
				line('user', '2026-09-28T02:05:00Z', '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'),
				line('user', '2026-09-28T02:05:01Z', '<local-command-stdout>Set model</local-command-stdout>'),
			].join('\n') + '\n',
		);
		const prev = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = dir;
		try {
			const info = await readTranscript('slash');
			expect(info?.instruction).toEqual({text: '/review 12', ts: Date.parse('2026-09-28T02:00:00Z')});
		} finally {
			if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = prev;
		}
	});
});

describe('描画(シナリオ 24、DESIGN.md「描画とキー入力」)', () => {
	const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
	const mkStore = (n: number) => {
		const store = new Store();
		for (let i = 0; i < n; i++) {
			const sid = `s${String(i).padStart(2, '0')}`;
			const row = bg({sessionId: sid, id: sid, name: `session-${i}-日本語の長い名前`, state: 'done', status: 'idle', pid: 1});
			store.rows.push(row);
			store.sessions.set(sid, {sid, row, name: row.name!, own: 'review', since: 1000 * i, note: 'レビューをお願いします。変更点は3つです。'.repeat(3), bangs: [], running: []});
		}
		store.lastRefresh = 100000;
		return store;
	};
	it('すべての行を端末の幅に収め、行数も高さを超えない', () => {
		const store = mkStore(20);
		store.cursor = 's10';
		for (const [cols, rows] of [[40, 10], [80, 24], [120, 5]] as const) {
			const lines = frame(store, {cols, rows});
			expect(lines.length).toBeLessThanOrEqual(rows);
			for (const l of lines) expect(width(strip(l))).toBeLessThanOrEqual(cols);
		}
	});
	it('収まらないときは選んだ行が見え、<通し番号>/<総数> が出る。3行の端末でもヘッダは残る', () => {
		const store = mkStore(20);
		store.cursor = 's15';
		const lines = frame(store, {cols: 100, rows: 12}).map(strip);
		expect(lines.some(l => l.startsWith('> '))).toBe(true);
		expect(lines.some(l => l.trim() === '16/20')).toBe(true);
		const tiny = frame(store, {cols: 100, rows: 3}).map(strip);
		expect(tiny[0]).toContain('whatnext');
		expect(tiny[1]).toContain('SESSION');
	});
});
