import {describe, expect, it} from 'vitest';
import {followCursor, initialCursor} from '../../src/model/cursor.js';
import {groupTitles, layout} from '../../src/model/layout.js';
import {canLink, cascade, waitCandidates} from '../../src/model/relations.js';
import type {Inputs, Row, Tier, Times} from '../../src/model/types.js';

const bg = (sid: string, tier: Tier | null, group = '/r/app', name = sid): Row => ({
  sid,
  id: sid.slice(0, 8),
  kind: 'background',
  name,
  tier,
  group,
});
const tty = (sid: string, tier: Tier | null, group = '/r/app', name = sid): Row => ({
  sid,
  kind: 'interactive',
  name,
  tier,
  group,
});

const inputs = (
  rows: Row[],
  waits: Record<string, string[]> = {},
  spawner: Record<string, string> = {},
  times: Record<string, Times> = {},
): Inputs => ({
  rows,
  waits: new Map(Object.entries(waits)),
  spawner: new Map(Object.entries(spawner)),
  times: new Map(Object.entries(times)),
});

const shape = (inp: Inputs) =>
  layout(inp).groups.map(g => ({
    title: g.title,
    rows: g.nodes.map(n => `${'  '.repeat(n.depth)}${n.sid}${n.spawned ? ' (sub)' : ''}`),
  }));

describe('待ちの段', () => {
  it('待ち先が稼働している間、レビュー待ちの待ち元は待ちの段になる(17)', () => {
    const l = layout(inputs([bg('A', 'review'), bg('B', 'working')], {A: ['B']}));
    expect(l.tier.get('A')).toBe('waiting');
    expect(l.parent.get('B')).toBe('A');
  });
  it('待ち先がすべてレビュー待ちか停止になるか一覧から消えると、自分の段に戻る(18、20、73)', () => {
    expect(layout(inputs([bg('A', 'review'), bg('B', 'review')], {A: ['B']})).tier.get('A')).toBe('review');
    expect(layout(inputs([bg('A', 'review'), bg('B', 'stopped')], {A: ['B']})).tier.get('A')).toBe('review');
    expect(layout(inputs([bg('A', 'review'), tty('B', null)], {A: ['B']})).tier.get('A')).toBe('review');
    expect(layout(inputs([bg('A', 'review')], {A: ['B']})).tier.get('A')).toBe('review');
    const two = inputs([bg('A', 'review'), bg('B', 'review'), bg('C', 'working')], {A: ['B', 'C']});
    expect(layout(two).tier.get('A')).toBe('waiting');
  });
  it('待ち元が自分で人の手の要る段や稼働中なら、自分の段に出る(19)', () => {
    for (const t of ['permission', 'question', 'sandbox', 'failed', 'working'] as const) {
      expect(layout(inputs([bg('A', t), bg('B', 'working')], {A: ['B']})).tier.get('A')).toBe(t);
    }
  });
  it('待ち先が待ちの段なら、終わっていない', () => {
    const l = layout(inputs([bg('A', 'review'), bg('B', 'review'), bg('C', 'working')], {A: ['B'], B: ['C']}));
    expect(l.tier.get('B')).toBe('waiting');
    expect(l.tier.get('A')).toBe('waiting');
  });
  it('起動された行が動いていても、起動元の段は変わらない(68)', () => {
    const l = layout(inputs([bg('P', 'review'), tty('S', 'working')], {}, {S: 'P'}));
    expect(l.tier.get('P')).toBe('review');
    expect(l.parent.get('S')).toBe('P');
  });
});

describe('木にならない関係を読み飛ばす(74、D1)', () => {
  it('1つの待ち先を2つの待ち元が待つ関係は、どちらも結ばれていないものとして扱う', () => {
    const inp = inputs([bg('A', 'review'), bg('B', 'review'), bg('C', 'working')], {A: ['C'], B: ['C']});
    const l = layout(inp);
    expect(l.parent.size).toBe(0);
    expect(l.tier.get('A')).toBe('review');
    expect(l.tier.get('B')).toBe('review');
  });
  it('一周する関係は読み飛ばし、輪の外の関係は残す', () => {
    const inp = inputs([bg('A', 'review'), bg('B', 'review'), bg('C', 'working')], {A: ['B'], B: ['A'], C: []});
    const l = layout(inp);
    expect(l.parent.size).toBe(0);
    expect(l.tier.get('A')).toBe('review');
    const inp2 = inputs([bg('A', 'review'), bg('B', 'review'), bg('D', 'review'), bg('E', 'working')], {
      A: ['B'],
      B: ['A'],
      D: ['E'],
    });
    expect(layout(inp2).parent.get('E')).toBe('D');
  });
  it('(tty) の行を待ち元にした関係は読み飛ばす', () => {
    const l = layout(inputs([tty('Q', 'question'), bg('B', 'working')], {Q: ['B']}));
    expect(l.parent.size).toBe(0);
  });
  it('起動された行に結ばれた関係は外す', () => {
    const rows = [bg('A', 'review'), tty('S', 'working'), bg('P', 'review')];
    const l = layout(inputs(rows, {A: ['S']}, {S: 'P'}));
    expect(l.parent.get('S')).toBe('P');
    expect(l.tier.get('A')).toBe('review');
  });
  it('(tty) の行は待ち先になれる(72)', () => {
    const l = layout(inputs([bg('A', 'review'), tty('Q', 'question')], {A: ['Q']}));
    expect(l.parent.get('Q')).toBe('A');
    expect(l.tier.get('A')).toBe('waiting');
  });
});

describe('区切りと並び', () => {
  it('区切りは見出しの人の読み方の順に並ぶ(61、76)', () => {
    const inp = inputs([bg('a', 'review', '/r/Zeta'), bg('b', 'review', '/r/alpha'), bg('c', 'review', '/r/beta')]);
    expect(shape(inp).map(g => g.title)).toEqual(['alpha', 'beta', 'Zeta']);
  });
  it('同じ名前のリポジトリは親のディレクトリ名を足して見分ける(63)', () => {
    const t = groupTitles(['/g/github.com/a/foo', '/g/github.com/b/foo', '/g/bar']);
    expect([...t.values()]).toEqual(['a/foo', 'b/foo', 'bar']);
    const t2 = groupTitles(['/x/a/foo', '/y/a/foo']);
    expect([...t2.values()]).toEqual(['x/a/foo', 'y/a/foo']);
  });
  it('区切りの中は最後に attach した順、なければ初めて見た時刻で並ぶ(62)', () => {
    const inp = inputs(
      [bg('A', 'review'), bg('B', 'working'), bg('C', 'review')],
      {},
      {},
      {
        A: {first: 1, attached: 10},
        B: {first: 20},
        C: {first: 2, attached: 5},
      },
    );
    expect(shape(inp)[0].rows).toEqual(['B', 'A', 'C']);
  });
  it('時刻が同じ行は名前の人の読み方の順に並ぶ(76)', () => {
    const inp = inputs(
      [bg('1', 'review', '/r/app', 'Zeta'), bg('2', 'review', '/r/app', 'alpha'), bg('3', 'review', '/r/app', 'beta')],
      {},
      {},
      {1: {first: 5}, 2: {first: 5}, 3: {first: 5}},
    );
    expect(shape(inp)[0].rows).toEqual(['2', '3', '1']);
  });
  it('段が変わっても並びは変わらない(62)', () => {
    const times = {A: {first: 1, attached: 10}, B: {first: 1, attached: 20}};
    const before = shape(inputs([bg('A', 'review'), bg('B', 'working')], {}, {}, times));
    const after = shape(inputs([bg('A', 'permission'), bg('B', 'stopped')], {}, {}, times));
    expect(after).toEqual(before);
  });
  it('待ち先の木は根のリポジトリの区切りに入り、待ち先のリポジトリの区切りには出ない(64)', () => {
    const inp = inputs([bg('A', 'review', '/r/app'), bg('B', 'working', '/r/lib'), bg('L', 'review', '/r/lib')], {
      A: ['B'],
    });
    expect(shape(inp)).toEqual([
      {title: 'app', rows: ['A', '  B']},
      {title: 'lib', rows: ['L']},
    ]);
  });
  it('待ち先に attach すると組が区切りの先頭に上がる(64)', () => {
    const inp = inputs(
      [bg('A', 'review'), bg('B', 'working'), bg('C', 'review')],
      {A: ['B']},
      {},
      {
        A: {first: 1},
        B: {first: 1, attached: 30},
        C: {first: 1, attached: 20},
      },
    );
    expect(shape(inp)[0].rows).toEqual(['A', '  B', 'C']);
  });
  it('一度も attach していない待ち先を結んでも、待ち先の初めて見た時刻では組は動かない', () => {
    const inp = inputs(
      [bg('A', 'review'), bg('B', 'working'), bg('C', 'review')],
      {A: ['B']},
      {},
      {
        A: {first: 1},
        B: {first: 50},
        C: {first: 1, attached: 20},
      },
    );
    expect(shape(inp)[0].rows).toEqual(['C', 'A', '  B']);
  });
  it('兄弟は触った時刻の新しい順に並ぶ', () => {
    const inp = inputs(
      [bg('A', 'review'), bg('B', 'working'), bg('C', 'working')],
      {A: ['B', 'C']},
      {},
      {
        A: {first: 1},
        B: {first: 2},
        C: {first: 3},
      },
    );
    expect(shape(inp)[0].rows).toEqual(['A', '  C', '  B']);
  });
  it('メモは並びにも段にも効かない(65): 段と並びはメモを受け取らない', () => {
    const inp = inputs([bg('A', 'review'), bg('B', 'review')], {}, {}, {A: {first: 2}, B: {first: 1}});
    expect(shape(inp)[0].rows).toEqual(['A', 'B']);
  });
});

describe('起動された行(67、71)', () => {
  it('起動元の下に入れ子で並び、さらに起動した行はもう一段深く並ぶ', () => {
    const inp = inputs([bg('P', 'working'), tty('S1', 'working'), tty('S2', 'working')], {}, {S1: 'P', S2: 'S1'});
    expect(shape(inp)[0].rows).toEqual(['P', '  S1 (sub)', '    S2 (sub)']);
  });
  it('起動元が一覧に出ていない間はトップレベルに (sub) で並び、出れば入れ子に入る', () => {
    const rows = [tty('Q', null), tty('S', 'working')];
    expect(shape(inputs(rows, {}, {S: 'Q'}))[0].rows).toEqual(['S (sub)']);
    const rows2 = [tty('Q', 'working'), tty('S', 'working')];
    expect(shape(inputs(rows2, {}, {S: 'Q'}))[0].rows).toEqual(['Q', '  S (sub)']);
  });
  it('起動された行は起動元の区切りに入る', () => {
    const inp = inputs([bg('P', 'working', '/r/app'), tty('S', 'working', '/r/lib')], {}, {S: 'P'});
    expect(shape(inp)).toEqual([{title: 'app', rows: ['P', '  S (sub)']}]);
  });
  it('待ち先と起動された行を同じ木に並べる', () => {
    const inp = inputs(
      [bg('A', 'review'), bg('B', 'working'), tty('S', 'working')],
      {A: ['B']},
      {S: 'B'},
      {
        A: {first: 1},
      },
    );
    expect(shape(inp)[0].rows).toEqual(['A', '  B', '    S (sub)']);
    expect(layout(inp).tier.get('A')).toBe('waiting');
  });
});

describe('入れ子の線の情報', () => {
  it('兄弟の最後と祖先の最後を返す', () => {
    const inp = inputs(
      [bg('A', 'review'), bg('B', 'working'), bg('C', 'working'), bg('D', 'working')],
      {
        A: ['B', 'C'],
        B: ['D'],
      },
      {},
      {B: {first: 2}, C: {first: 1}},
    );
    const nodes = layout(inp).groups[0].nodes;
    expect(nodes.map(n => [n.sid, n.depth, n.last, n.ancestorsLast, n.hasChildren])).toEqual([
      ['A', 0, true, [], true],
      ['B', 1, false, [], true],
      ['D', 2, true, [false], false],
      ['C', 1, true, [], false],
    ]);
  });
});

describe('f のメニューと削除の巻き込み', () => {
  const inp = inputs(
    [
      bg('A', 'review'),
      bg('B', 'working'),
      bg('C', 'review'),
      tty('Q', 'question'),
      tty('S', 'working'),
      bg('D', 'review'),
    ],
    {A: ['B'], B: ['C'], D: []},
    {S: 'A'},
    {A: {first: 5}, D: {first: 4}, Q: {first: 3}},
  );
  it('待ち元自身、起動された行、一周する行、ほかの待ち元の待ち先を並べない(20、69)', () => {
    const l = layout(inp);
    expect(waitCandidates(inp, l, 'B')).toEqual([
      {sid: 'C', linked: true},
      {sid: 'D', linked: false},
      {sid: 'Q', linked: false},
    ]);
    expect(waitCandidates(inp, l, 'D').map(c => c.sid)).toEqual(['A', 'Q']);
  });
  it('結べるか', () => {
    expect(canLink(inp, 'C', 'A')).toBe(false);
    expect(canLink(inp, 'D', 'C')).toBe(false);
    expect(canLink(inp, 'D', 'S')).toBe(false);
    expect(canLink(inp, 'Q', 'D')).toBe(false);
    expect(canLink(inp, 'D', 'Q')).toBe(true);
    expect(canLink(inp, 'A', 'D')).toBe(true);
  });
  it('巻き込むのは待ち先と待ち先の待ち先の background の行だけ(22)', () => {
    expect(cascade(inp, 'A')).toEqual(['B', 'C']);
    const withTty = inputs([bg('A', 'review'), tty('Q', 'question')], {A: ['Q']});
    expect(cascade(withTty, 'A')).toEqual([]);
  });
});

describe('カーソル', () => {
  it('起動したときは最も新しく attach したセッション(66)', () => {
    const inp = inputs(
      [bg('A', 'review', '/r/a'), bg('B', 'review', '/r/b')],
      {},
      {},
      {
        A: {first: 1, attached: 5},
        B: {first: 1, attached: 9},
      },
    );
    expect(initialCursor(layout(inp), inp.times)).toBe('B');
  });
  it('消えたら同じ区切りの次の行、なければ前の行、空なら隣の区切り(5)', () => {
    const t = {A: {first: 3}, B: {first: 2}, C: {first: 1}};
    const prev = layout(
      inputs([bg('A', 'review'), bg('B', 'review'), bg('C', 'review'), bg('X', 'review', '/r/x')], {}, {}, t),
    );
    expect(followCursor(prev, 'B', layout(inputs([bg('A', 'review'), bg('C', 'review')], {}, {}, t)))).toBe('C');
    expect(followCursor(prev, 'C', layout(inputs([bg('A', 'review'), bg('B', 'review')], {}, {}, t)))).toBe('B');
    expect(followCursor(prev, 'X', layout(inputs([bg('A', 'review'), bg('B', 'review')], {}, {}, t)))).toBe('B');
  });
  it('消えた起動された行からは起動元へ。2段なら大本の起動元へ(70)', () => {
    const rows = [bg('W', 'review'), bg('P', 'working'), tty('S1', 'working'), tty('S2', 'working')];
    const prev = layout(inputs(rows, {W: ['P']}, {S1: 'P', S2: 'S1'}));
    const next = layout(inputs([bg('W', 'review'), bg('P', 'working'), tty('S1', 'working')], {W: ['P']}, {S1: 'P'}));
    expect(followCursor(prev, 'S2', next)).toBe('P');
    expect(followCursor(prev, 'S1', layout(inputs([bg('W', 'review'), bg('P', 'working')], {W: ['P']})))).toBe('P');
    // 大本の起動元も消え、すぐ上の起動元がトップレベルの (tty) の行になった
    const gone = layout(inputs([bg('W', 'review'), tty('S1', 'working')], {W: ['P']}));
    expect(followCursor(prev, 'S2', gone)).toBe('S1');
  });
  it('起動された行と大本の起動元が同時に消えたら、大本の起動元が消えたものとして隣を選ぶ', () => {
    const t = {A: {first: 9}, P: {first: 5}, T: {first: 2}, B: {first: 1}};
    const rows = [bg('A', 'review'), bg('P', 'working'), bg('T', 'working'), tty('S', 'working'), bg('B', 'review')];
    const prev = layout(inputs(rows, {P: ['T']}, {S: 'P'}, {...t, S: {first: 8}}));
    expect(prev.order).toEqual(['A', 'P', 'S', 'T', 'B']);
    const next = layout(inputs([bg('A', 'review'), bg('T', 'working'), bg('B', 'review')], {}, {}, t));
    expect(followCursor(prev, 'S', next)).toBe('T');
  });
  it('自動で移るときは起動された行を選ばない', () => {
    const t = {A: {first: 3}, P: {first: 2}};
    const prev = layout(inputs([bg('A', 'review'), bg('P', 'working'), tty('S', 'working')], {}, {S: 'P'}, t));
    const next = layout(inputs([bg('P', 'working'), tty('S', 'working')], {}, {S: 'P'}, t));
    expect(followCursor(prev, 'A', next)).toBe('P');
  });
});
