import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {emptyState, parseState, StateFile, serialize, statePath} from '../../src/state/state.js';

describe('状態のファイル', () => {
  it('置き場所は XDG_STATE_HOME とソケット名で決まる', () => {
    expect(statePath({XDG_STATE_HOME: '/s'})).toBe('/s/whatnext/state.json');
    expect(statePath({XDG_STATE_HOME: '/s', WHATNEXT_TMUX_SOCKET: 'wn-test'})).toBe('/s/whatnext/state-wn-test.json');
  });
  it('版 3 を読み書きする', () => {
    const s = emptyState();
    s.notes.set('a', '素材待ち');
    s.waits.set('a', ['b']);
    s.seen.set('a', {first: 1, attached: 2});
    s.seen.set('b', {first: 3});
    const p = parseState(serialize(s));
    expect(p.kind).toBe('ok');
    if (p.kind !== 'ok') return;
    expect(p.state).toEqual(s);
    expect(JSON.parse(serialize(s))).toEqual({
      version: 3,
      notes: {a: '素材待ち'},
      waits: {a: ['b']},
      seen: {a: {first: 1, attached: 2}, b: {first: 3}},
    });
  });
  it('版 1・2 の保留の理由をメモとして読み、空の理由はメモなし、view は読み捨てる(15)', () => {
    const v2 = JSON.stringify({
      version: 2,
      holds: {a: 'Bob の返事待ち', b: '', c: {reason: '余裕があるとき'}},
      waits: {a: ['x']},
      seen: {a: {first: 5}},
      view: 'repo',
    });
    const p = parseState(v2);
    if (p.kind !== 'ok') throw new Error(p.kind);
    expect([...p.state.notes]).toEqual([
      ['a', 'Bob の返事待ち'],
      ['c', '余裕があるとき'],
    ]);
    expect(p.state.waits.get('a')).toEqual(['x']);
    expect(p.state.seen.get('a')).toEqual({first: 5});
    const v1 = parseState(JSON.stringify({version: 1, holds: {a: 'r'}, waits: {}, seen: {a: {first: 1}}}));
    if (v1.kind !== 'ok') throw new Error(v1.kind);
    expect(v1.state.seen.size).toBe(0);
  });
  it('知らない版と壊れた中身は読めないものとして返す', () => {
    expect(parseState('{').kind).toBe('unreadable');
    expect(parseState('{"version":4}').kind).toBe('unreadable');
    expect(parseState('[]').kind).toBe('unreadable');
  });
  it('読めなかったファイルは、メモか待ち先を変えるまで置き換えない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wn-state-'));
    const path = join(dir, 'whatnext', 'state.json');
    const f0 = new StateFile(path);
    f0.save(emptyState(), true);
    writeFileSync(path, '{"version":9,"future":true}');
    const f = new StateFile(path);
    const s = f.load();
    s.seen.set('a', {first: 1});
    expect(f.save(s, false)).toBe(false);
    expect(readFileSync(path, 'utf8')).toContain('future');
    s.notes.set('a', 'n');
    expect(f.save(s, true)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).notes).toEqual({a: 'n'});
    expect(f.save(s, false)).toBe(false);
  });
  it('ないファイルは空として読み、時刻を書く', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wn-state-'));
    const f = new StateFile(join(dir, 'x', 'state.json'));
    const s = f.load();
    expect(s.notes.size).toBe(0);
    s.seen.set('a', {first: 1});
    expect(f.save(s, false)).toBe(true);
  });
});
