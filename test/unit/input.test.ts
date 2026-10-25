import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {spawners} from '../../src/input/spawners.js';
import {loadState, readState, StateWriter, statePath} from '../../src/state/store.js';

describe('状態のファイル', () => {
  it('書いて読み戻す。壊れたファイルや違う版は空として読む', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wn-st-'));
    const path = statePath({XDG_STATE_HOME: dir}, 'wn-test');
    expect(path).toBe(join(dir, 'whatnext', 'state-wn-test.json'));
    expect(statePath({XDG_STATE_HOME: dir}, 'whatnext')).toBe(join(dir, 'whatnext', 'state.json'));
    const w = new StateWriter(path);
    await w.save({
      holds: new Map([['a', 'later']]),
      waits: new Map([['b', ['c']]]),
      view: 'repo',
      seen: new Map([
        ['a', {first: 1, attached: 5}],
        ['b', {first: 2}],
      ]),
    });
    const back = await loadState(path);
    expect([...back.holds]).toEqual([['a', 'later']]);
    expect([...back.waits]).toEqual([['b', ['c']]]);
    expect(back.view).toBe('repo');
    expect([...back.seen]).toEqual([
      ['a', {first: 1, attached: 5}],
      ['b', {first: 2}],
    ]);
    await writeFile(path, '{broken');
    expect((await loadState(path)).holds.size).toBe(0);
    await writeFile(path, JSON.stringify({version: 3, holds: {a: ''}}));
    expect((await loadState(path)).holds.size).toBe(0);
  });

  it('読めなかったファイルは、時刻が変わっただけでは置き換えず、保留を変えたら置き換える', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wn-st-'));
    const path = statePath({XDG_STATE_HOME: dir}, 'wn-test');
    await mkdir(join(dir, 'whatnext'), {recursive: true});
    const newer = JSON.stringify({version: 3, holds: {a: 'later'}});
    await writeFile(path, newer);
    const {state, unreadable} = await readState(path);
    expect(unreadable).toBe(true);
    const w = new StateWriter(path, state, {keepUnreadable: unreadable});
    await w.save({...state, seen: new Map([['a', {first: 1}]])});
    expect(await readFile(path, 'utf8')).toBe(newer);
    await w.save({...state, holds: new Map([['b', 'mine']]), seen: new Map([['a', {first: 1}]])});
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({version: 2, holds: {b: 'mine'}});
    expect((await readState(join(dir, 'none.json'))).unreadable).toBe(false);
    // ディレクトリなど、ないのではなく読めないものは置き換えない側に入る
    expect((await readState(dir)).unreadable).toBe(true);
  });

  it('版 1 のファイルは、保留と待ち先の関係を読み継ぎ、ビューはラダーのビューにする (ADR-0018)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wn-st-'));
    const path = statePath({XDG_STATE_HOME: dir}, 'wn-test');
    await mkdir(join(dir, 'whatnext'), {recursive: true});
    await writeFile(path, JSON.stringify({version: 1, holds: {a: 'later'}, waits: {b: ['c']}}));
    const back = await loadState(path);
    expect([...back.holds]).toEqual([['a', 'later']]);
    expect([...back.waits]).toEqual([['b', ['c']]]);
    expect(back.view).toBe('ladder');
    expect(back.seen.size).toBe(0);
  });
});

describe('起動元 (シナリオ 67)', () => {
  it('pid の祖先をたどり、最初に当たった別の行を起動元とする', () => {
    // 33192 の行 → zsh → claude -p(43087) → stdio の MCP サーバ → claude -p(44959)
    const parents = new Map([
      [44959, 43315],
      [43315, 43087],
      [43087, 43085],
      [43085, 33192],
      [33192, 33187],
      [33187, 5671],
      [5671, 1],
      [70000, 5671],
    ]);
    const rows = [
      {sessionId: 'me', pid: 33192},
      {sessionId: 'mid', pid: 43087},
      {sessionId: 'leaf', pid: 44959},
      {sessionId: 'other', pid: 70000},
      {sessionId: 'stopped'},
    ];
    expect(spawners(rows, parents)).toEqual(
      new Map([
        ['mid', 'me'],
        ['leaf', 'mid'],
      ]),
    );
  });

  it('親の表が一周していても止まる', () => {
    const parents = new Map([
      [10, 11],
      [11, 10],
    ]);
    expect(spawners([{sessionId: 'a', pid: 10}], parents).size).toBe(0);
  });

  it('background の行は、祖先に別の行があっても起動された行にしない', () => {
    const rows = [
      {sessionId: 'p', pid: 10, kind: 'interactive'},
      {sessionId: 'b', pid: 20, kind: 'background'},
    ];
    expect(spawners(rows, new Map([[20, 10]])).size).toBe(0);
  });

  it('表に pid がない行は、起動元が残っていれば前回の関係を持ち越す', () => {
    const rows = [
      {sessionId: 'p', pid: 10},
      {sessionId: 'c', pid: 20},
      {sessionId: 'orphan', pid: 30},
    ];
    const prev = new Map([
      ['c', 'p'],
      ['orphan', 'gone'],
    ]);
    // ps が読めなかった回(空の表)と、--json のあとに c が終わった回
    expect(spawners(rows, new Map(), prev)).toEqual(new Map([['c', 'p']]));
    expect(spawners(rows, new Map([[10, 1]]), prev)).toEqual(new Map([['c', 'p']]));
  });

  it('読む間に起動元のプロセスが終わって親が付け替わった行は、起動元の行に pid があるときだけ持ち越す', () => {
    const prev = new Map([['c', 'p']]);
    const reparented = new Map([
      [10, 1],
      [20, 1],
    ]);
    expect(
      spawners(
        [
          {sessionId: 'p', pid: 10},
          {sessionId: 'c', pid: 20},
        ],
        reparented,
        prev,
      ),
    ).toEqual(new Map([['c', 'p']]));
    // 起動元の行が止まって pid がなくなったら、持ち越さない(止めた起動元の下に残り続けない)
    expect(spawners([{sessionId: 'p'}, {sessionId: 'c', pid: 20}], reparented, prev).size).toBe(0);
  });
});
