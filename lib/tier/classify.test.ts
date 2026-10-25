import {describe, expect, it} from 'vitest';
import {type AgentRow, classify, dedupe, rowName} from './classify.js';

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
    // status が waiting でも、添えるのは規則に当たらなかった原因の state の値(#265)
    expect(classify(bg('a', {state: 'blocked', status: 'waiting'}))).toEqual({tier: 'question', reason: 'blocked'});
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

  it('どちらも pid があれば background を採る(#265)', () => {
    const live: AgentRow = {kind: 'interactive', sessionId: 'x', cwd: '/', status: 'waiting', pid: 5};
    const bgLive: AgentRow = {kind: 'background', sessionId: 'x', id: 'x', cwd: '/', state: 'working', pid: 6};
    expect(dedupe([live, bgLive])).toEqual([bgLive]);
    expect(dedupe([bgLive, live])).toEqual([bgLive]);
  });

  it('name がなければ id を名前にする', () => {
    expect(rowName({kind: 'background', sessionId: 'abcdefgh-1', id: 'abcdefgh', cwd: '/'})).toBe('abcdefgh');
  });
});
