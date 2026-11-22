import {describe, expect, it} from 'vitest';
import {paneCommand, readEnv, tooOldTmux} from '../../src/cli/env.js';

describe('tmux の版の確かめ', () => {
  it('3.5 より古い版は断る', () => {
    expect(tooOldTmux('tmux 3.4')).toBe(true);
    expect(tooOldTmux('tmux 3.3a')).toBe(true);
    expect(tooOldTmux('tmux 2.9')).toBe(true);
  });

  it('3.5 以降は断らない', () => {
    expect(tooOldTmux('tmux 3.5')).toBe(false);
    expect(tooOldTmux('tmux 3.5a')).toBe(false);
    expect(tooOldTmux('tmux 3.6a')).toBe(false);
    expect(tooOldTmux('tmux 3.7')).toBe(false);
    expect(tooOldTmux('tmux 3.7c')).toBe(false);
    expect(tooOldTmux('tmux 3.8')).toBe(false);
    expect(tooOldTmux('tmux 3.10')).toBe(false);
    expect(tooOldTmux('tmux 4.0')).toBe(false);
    expect(tooOldTmux('tmux next-3.9')).toBe(false);
  });

  it('版を読み取れない表記は断らない', () => {
    expect(tooOldTmux('tmux master')).toBe(false);
    expect(tooOldTmux('tmux openbsd-7.6')).toBe(false);
    expect(tooOldTmux('')).toBe(false);
  });
});

describe('更新と Usage の間隔のつまみ(テスト専用の環境変数)', () => {
  it('渡さないときは 60 秒', () => {
    const env = readEnv({});
    expect(env.refreshMs).toBe(60_000);
    expect(env.usageMinMs).toBe(60_000);
  });

  it('正の数を渡すと、その間隔になる', () => {
    const env = readEnv({WHATNEXT_REFRESH_MS: '12000', WHATNEXT_USAGE_MIN_MS: '10000'});
    expect(env.refreshMs).toBe(12_000);
    expect(env.usageMinMs).toBe(10_000);
  });

  it('数でない値、0 以下の値は 60 秒', () => {
    for (const v of ['', ' ', 'abc', '10s', '0', '-5', 'NaN', 'Infinity']) {
      const env = readEnv({WHATNEXT_REFRESH_MS: v, WHATNEXT_USAGE_MIN_MS: v});
      expect(env.refreshMs, v).toBe(60_000);
      expect(env.usageMinMs, v).toBe(60_000);
    }
  });

  it('一覧のペインには、既定と違うときだけ渡す', () => {
    const short = readEnv({WHATNEXT_REFRESH_MS: '12000', WHATNEXT_USAGE_MIN_MS: '10000'});
    expect(paneCommand(short, 'list', {})).toMatch(/WHATNEXT_REFRESH_MS='?12000'? WHATNEXT_USAGE_MIN_MS='?10000'?/);
    expect(paneCommand(short, 'guide', {})).not.toMatch(/WHATNEXT_REFRESH_MS|WHATNEXT_USAGE_MIN_MS/);
    expect(paneCommand(readEnv({}), 'list', {})).not.toMatch(/WHATNEXT_REFRESH_MS|WHATNEXT_USAGE_MIN_MS/);
  });
});
