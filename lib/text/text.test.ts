import {describe, expect, it} from 'vitest';
import {color, oneLine, padEnd, padStart, stripAnsi, truncate, width} from './text.js';

describe('幅と切り詰め', () => {
  it('全角は2桁、曖昧幅の罫線は1桁、色は0桁で数える', () => {
    expect(width('abc')).toBe(3);
    expect(width('日本語')).toBe(6);
    expect(width('── x ──')).toBe(7);
    expect(width(color.bold('ab'))).toBe(2);
  });

  it('切り詰めは … を含めて幅に収める', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(width(truncate('日本語のセッション', 7))).toBeLessThanOrEqual(7);
    expect(truncate('abc', 5)).toBe('abc');
  });

  it('表示幅で揃える', () => {
    expect(padEnd('日本', 6)).toBe('日本  ');
    expect(padStart('5m', 4)).toBe('  5m');
  });

  it('色を外し、改行とタブを空白にする', () => {
    expect(stripAnsi(color.bold('x'))).toBe('x');
    expect(oneLine('a\nb\tc')).toBe('a b c');
  });
});
