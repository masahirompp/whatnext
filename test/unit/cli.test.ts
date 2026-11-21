import {describe, expect, it} from 'vitest';
import {tooOldTmux} from '../../src/cli/env.js';

describe('tmux の版の確かめ', () => {
  it('3.7 より古い版は断る', () => {
    expect(tooOldTmux('tmux 3.4')).toBe(true);
    expect(tooOldTmux('tmux 3.6a')).toBe(true);
    expect(tooOldTmux('tmux 2.9')).toBe(true);
  });

  it('3.7 以降は断らない', () => {
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
