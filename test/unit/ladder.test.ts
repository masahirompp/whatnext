import {describe, expect, it} from 'vitest';
import {
  type ArrangeInput,
  arrange,
  emptyDoneMemo,
  emptyWaitMemo,
  flatten,
  noteFor,
  subtreeOf,
  trackWaits,
} from '../../src/ladder/arrange.js';
import {type AgentRow, classify, dedupe, rowName} from '../../src/ladder/classify.js';

let seq = 0;
function bg(name: string, extra: Partial<AgentRow> = {}): AgentRow {
  seq++;
  const id = `${name.slice(0, 4)}${String(seq).padStart(4, '0')}`;
  return {
    kind: 'background',
    sessionId: `${id}-0000-4000-8000-000000000000`,
    id,
    cwd: '/repo',
    name,
    pid: 100 + seq,
    state: 'done',
    status: 'idle',
    ...extra,
  };
}

function input(rows: AgentRow[], extra: Partial<ArrangeInput> = {}): ArrangeInput {
  return {
    rows,
    holds: new Map(),
    waits: new Map(),
    lastAttached: null,
    waitSince: new Map(),
    sups: new Map(),
    doneMemo: emptyDoneMemo,
    ...extra,
  };
}

describe('classify (シナリオ 4)', () => {
  it('waitingFor を最優先にする', () => {
    expect(classify(bg('a', {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'}))).toEqual({
      tier: 'permission',
    });
    expect(classify(bg('a', {state: 'blocked', status: 'waiting', waitingFor: 'input needed'})).tier).toBe('question');
    expect(classify(bg('a', {state: 'blocked', status: 'waiting', waitingFor: 'sandbox request'})).tier).toBe(
      'sandbox',
    );
    expect(
      classify({kind: 'interactive', sessionId: 's', cwd: '/', status: 'waiting', waitingFor: 'permission prompt'}),
    ).toEqual({tier: 'permission'});
  });

  it('表にない waitingFor は生の値を添えて質問待ちにする', () => {
    expect(classify(bg('a', {state: 'blocked', status: 'waiting', waitingFor: 'dialog open'}))).toEqual({
      tier: 'question',
      reason: 'dialog open',
    });
  });

  it('pid のない blocked は失敗、pid のある blocked は生の値を添えて質問待ち', () => {
    expect(classify(bg('a', {state: 'blocked', status: undefined, pid: undefined}))).toEqual({
      tier: 'failed',
      reason: 'no process',
    });
    expect(classify(bg('a', {state: 'blocked', status: 'idle'}))).toEqual({tier: 'question', reason: 'blocked'});
  });

  it('working + idle は質問待ち、working + busy は稼働中', () => {
    expect(classify(bg('a', {state: 'working', status: 'idle'}))).toEqual({tier: 'question'});
    expect(classify(bg('a', {state: 'working', status: 'busy'}))).toEqual({tier: 'working'});
  });

  it('done、failed、stopped', () => {
    expect(classify(bg('a')).tier).toBe('review');
    expect(classify(bg('a', {state: 'failed'})).tier).toBe('failed');
    expect(classify(bg('a', {state: 'stopped', pid: undefined, status: undefined})).tier).toBe('stopped');
  });

  it('interactive の idle は対象外、busy は稼働中', () => {
    expect(classify({kind: 'interactive', sessionId: 's', cwd: '/', status: 'idle', pid: 1}).tier).toBeNull();
    expect(classify({kind: 'interactive', sessionId: 's', cwd: '/', status: 'busy', pid: 1}).tier).toBe('working');
  });

  it('未知の state は生の値を添えて質問待ち', () => {
    expect(classify(bg('a', {state: 'paused', status: 'idle'}))).toEqual({tier: 'question', reason: 'paused'});
  });
});

describe('dedupe (シナリオ 4)', () => {
  it('pid のある行を採る', () => {
    const stopped: AgentRow = {kind: 'background', sessionId: 'x', id: 'x', cwd: '/', state: 'done'};
    const live: AgentRow = {kind: 'interactive', sessionId: 'x', cwd: '/', status: 'waiting', pid: 5};
    expect(dedupe([stopped, live])).toEqual([live]);
    expect(dedupe([live, stopped])).toEqual([live]);
  });

  it('どちらも pid がなければ background を採る', () => {
    const a: AgentRow = {kind: 'interactive', sessionId: 'x', cwd: '/'};
    const b: AgentRow = {kind: 'background', sessionId: 'x', id: 'x', cwd: '/', state: 'stopped'};
    expect(dedupe([a, b])).toEqual([b]);
  });

  it('name がなければ id を名前にする', () => {
    expect(rowName({kind: 'background', sessionId: 'abcdefgh-1', id: 'abcdefgh', cwd: '/'})).toBe('abcdefgh');
  });
});

describe('並び (シナリオ 1、3)', () => {
  it('段の順、同じ段の中は待機時間の長い順、待機時間の分からない行は先頭', () => {
    const review1 = bg('review-old');
    const review2 = bg('review-new');
    const review3 = bg('review-unknown');
    const perm = bg('perm', {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'});
    const work1 = bg('work-long', {state: 'working', status: 'busy'});
    const work2 = bg('work-short', {state: 'working', status: 'busy'});
    const stopped = bg('stopped', {state: 'stopped', pid: undefined, status: undefined});
    const waitSince = new Map<string, number | null>([
      [review1.sessionId, 100],
      [review2.sessionId, 500],
      [review3.sessionId, null],
      [perm.sessionId, 900],
      [work1.sessionId, 10],
      [work2.sessionId, 800],
      [stopped.sessionId, 1],
    ]);
    const a = arrange(input([stopped, work2, review2, review3, work1, perm, review1], {waitSince}));
    expect(flatten(a).map(e => e.name)).toEqual([
      'perm',
      'review-unknown',
      'review-old',
      'review-new',
      'work-long',
      'work-short',
      'stopped',
    ]);
    expect(a.lastAttached).toBeNull();
    expect(a.onHold).toEqual([]);
  });

  it('対象外の行は出ない', () => {
    const tty = {kind: 'interactive', sessionId: 'tty', cwd: '/', status: 'idle', pid: 1, name: 'tty'};
    expect(flatten(arrange(input([tty, bg('x')]))).map(e => e.name)).toEqual(['x']);
  });
});

describe('待機時間 (シナリオ 2、3)', () => {
  it('最初の更新で補う値がなければ不明、次の更新で新しく入った行は前回の更新から数える', () => {
    const s = 'a';
    const m1 = trackWaits(emptyWaitMemo, new Map([[s, 'review']]), new Map(), 1000);
    expect(m1.entries.get(s)?.since).toBeNull();
    const m2 = trackWaits(m1, new Map([[s, 'review']]), new Map(), 61000);
    expect(m2.entries.get(s)?.since).toBeNull();
    const m3 = trackWaits(m2, new Map([[s, 'permission']]), new Map(), 121000);
    expect(m3.entries.get(s)?.since).toBe(61000);
    const m4 = trackWaits(m3, new Map([[s, 'permission']]), new Map(), 181000);
    expect(m4.entries.get(s)?.since).toBe(61000);
  });

  it('フックや会話記録の時刻があればそれを使う', () => {
    const sups = new Map([
      ['w', {prompt: {text: 'x', at: 50}}],
      ['r', {haltAt: 70, prompt: {text: 'x', at: 50}}],
    ]);
    const m = trackWaits(
      emptyWaitMemo,
      new Map([
        ['w', 'working'],
        ['r', 'review'],
      ]),
      sups,
      1000,
    );
    expect(m.entries.get('w')?.since).toBe(50);
    expect(m.entries.get('r')?.since).toBe(70);
  });
});

describe('一言', () => {
  it('段ごとに選ぶ', () => {
    const sup = {
      prompt: {text: 'fix it', at: 1},
      permission: 'Bash: ls',
      question: 'Which?',
      declined: 'Bash: rm',
      error: 'API Error',
      lastText: 'Done.',
    };
    expect(noteFor('working', sup)).toBe('→ fix it');
    expect(noteFor('permission', sup)).toBe('Bash: ls');
    expect(noteFor('question', sup)).toBe('Which?');
    expect(noteFor('question', {declined: 'Bash: rm', lastText: 'x'})).toBe('Declined: Bash: rm');
    expect(noteFor('failed', sup)).toBe('API Error');
    expect(noteFor('review', sup)).toBe('Done.');
    expect(noteFor('working', {lastText: 'old'})).toBeUndefined();
  });
});

describe('Last attached と保留 (シナリオ 5、15)', () => {
  it('今離脱したセッションの組を先頭に出し、ラダーには出さない', () => {
    const a = bg('a', {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'});
    const b = bg('b');
    const r = arrange(input([a, b], {lastAttached: b.sessionId}));
    expect(r.lastAttached?.entries.map(e => e.name)).toEqual(['b']);
    expect(r.upNext.map(g => g.rootSid)).toEqual([a.sessionId]);
  });

  it('今離脱したセッションが対象外なら組を出さない', () => {
    const tty: AgentRow = {kind: 'interactive', sessionId: 't', cwd: '/', status: 'idle', pid: 1};
    const r = arrange(input([tty, bg('x')], {lastAttached: 't'}));
    expect(r.lastAttached).toBeNull();
  });

  it('保留の行は最下部の組に出て、Last attached には出ない', () => {
    const a = bg('a');
    const b = bg('b', {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'});
    const r = arrange(input([a, b], {holds: new Map([[b.sessionId, 'later']]), lastAttached: b.sessionId}));
    expect(r.lastAttached).toBeNull();
    expect(r.upNext.map(g => g.rootSid)).toEqual([a.sessionId]);
    expect(r.onHold[0]?.entries[0]?.holdReason).toBe('later');
  });
});

describe('待ち先 (シナリオ 17〜21)', () => {
  it('待ち先が稼働中なら待ち元は待ちの段に入り、待ち先が下に入れ子で並び、組は待ち先の位置に出る', () => {
    const A = bg('A');
    const B = bg('B', {state: 'working', status: 'busy'});
    const R = bg('R');
    const waits = new Map([[A.sessionId, [B.sessionId]]]);
    const waitSince = new Map([
      [A.sessionId, 1],
      [B.sessionId, 2],
      [R.sessionId, 3],
    ]);
    const r = arrange(input([A, B, R], {waits, waitSince}));
    expect(flatten(r).map(e => [e.name, e.status, e.depth])).toEqual([
      ['R', 'Review', 0],
      ['A', 'Waiting', 0],
      ['B', 'Working', 1],
    ]);
    expect(r.upNext[1]?.positionSid).toBe(B.sessionId);
  });

  it('待ち先が権限待ちなら組ごと上に来る', () => {
    const A = bg('A');
    const B = bg('B', {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'});
    const R = bg('R');
    const r = arrange(input([R, A, B], {waits: new Map([[A.sessionId, [B.sessionId]]])}));
    expect(flatten(r).map(e => e.name)).toEqual(['A', 'B', 'R']);
    expect(r.upNext[0]?.positionSid).toBe(B.sessionId);
  });

  it('待ち先がすべて終わると待ち元は元の段に戻り、done を出す。再び稼働すると消える (18)', () => {
    const A = bg('A');
    const Bw = bg('B', {state: 'working', status: 'busy'});
    const waits = new Map([[A.sessionId, [Bw.sessionId]]]);
    const r1 = arrange(input([A, Bw], {waits}));
    expect(r1.tiers.get(A.sessionId)).toBe('waiting');
    const Bd = {...Bw, state: 'done', status: 'idle'};
    const r2 = arrange(input([A, Bd], {waits, doneMemo: r1.doneMemo}));
    const a2 = flatten(r2).find(e => e.sid === A.sessionId);
    expect(a2?.tier).toBe('review');
    expect(a2?.doneNames).toEqual(['B']);
    const r3 = arrange(input([A, Bd], {waits, doneMemo: r2.doneMemo}));
    expect(flatten(r3).find(e => e.sid === A.sessionId)?.doneNames).toEqual(['B']);
    const r4 = arrange(input([A, Bw], {waits, doneMemo: r3.doneMemo}));
    expect(flatten(r4).find(e => e.sid === A.sessionId)?.doneNames).toBeUndefined();
    expect(r4.tiers.get(A.sessionId)).toBe('waiting');
  });

  it('待ち元が自分でも人の手の要る段なら自分の段に出る (19)', () => {
    const A = bg('A', {state: 'blocked', status: 'waiting', waitingFor: 'input needed'});
    const B = bg('B', {state: 'working', status: 'busy'});
    const r = arrange(input([A, B], {waits: new Map([[A.sessionId, [B.sessionId]]])}));
    expect(r.tiers.get(A.sessionId)).toBe('question');
  });

  it('待ち先が複数なら全部終わるまで待ち (20)', () => {
    const A = bg('A');
    const B = bg('B');
    const C = bg('C', {state: 'working', status: 'busy'});
    const waits = new Map([[A.sessionId, [B.sessionId, C.sessionId]]]);
    expect(arrange(input([A, B, C], {waits})).tiers.get(A.sessionId)).toBe('waiting');
    const C2 = {...C, state: 'stopped', status: undefined, pid: undefined};
    expect(arrange(input([A, B, C2], {waits})).tiers.get(A.sessionId)).toBe('review');
  });

  it('一覧に出なくなった待ち先は終わったとみなす', () => {
    const A = bg('A');
    const waits = new Map([[A.sessionId, ['gone']]]);
    expect(arrange(input([A], {waits})).tiers.get(A.sessionId)).toBe('review');
  });

  it('途中の行を保留にすると組に残って位置に数えず、根を保留にすると組ごと保留の組へ (21)', () => {
    const A = bg('A');
    const B = bg('B', {state: 'blocked', status: 'waiting', waitingFor: 'permission prompt'});
    const R = bg('R');
    const waits = new Map([[A.sessionId, [B.sessionId]]]);
    const waitSince = new Map([
      [A.sessionId, 1],
      [B.sessionId, 2],
      [R.sessionId, 3],
    ]);
    const mid = arrange(input([A, B, R], {waits, waitSince, holds: new Map([[B.sessionId, '']])}));
    expect(flatten(mid).map(e => [e.name, e.midHold])).toEqual([
      ['R', false],
      ['A', false],
      ['B', true],
    ]);
    const root = arrange(input([A, B, R], {waits, waitSince, holds: new Map([[A.sessionId, '']])}));
    expect(root.onHold[0]?.entries.map(e => e.name)).toEqual(['A', 'B']);
    expect(root.upNext.map(g => g.rootSid)).toEqual([R.sessionId]);
  });

  it('組の中の行を返す', () => {
    const A = bg('A');
    const B = bg('B');
    const C = bg('C');
    const waits = new Map([
      [A.sessionId, [B.sessionId]],
      [B.sessionId, [C.sessionId]],
    ]);
    const r = arrange(input([A, B, C], {waits}));
    expect(subtreeOf(r, A.sessionId)).toEqual([A.sessionId, B.sessionId, C.sessionId]);
    expect(subtreeOf(r, B.sessionId)).toEqual([B.sessionId, C.sessionId]);
    expect(flatten(r).map(e => e.lastChain)).toEqual([[], [true], [true, true]]);
  });
});
