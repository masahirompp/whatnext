import {existsSync, mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {digitName, makeTmpDir, TMP_DIGITS, tmpTag} from '../e2e/tmpdir.js';

// 画面の通しの一時ディレクトリの名前(#382)。絞り込みの入力がフルパスの乱数の部分に当たらないことを、ここで確かめる

let base: string | undefined;
afterEach(() => {
  if (base) rmSync(base, {recursive: true, force: true});
  base = undefined;
});
const prefix = () => {
  base = mkdtempSync(join(tmpdir(), 'wn-tmpdir-'));
  return join(base, 'wne-');
};
/** 決まった値を順に返す乱数。 */
const seq = (...vs: number[]) => {
  let i = 0;
  return () => vs[i++ % vs.length];
};

describe('画面の通しの一時ディレクトリ', () => {
  it('名前の乱数の部分は、決まった桁数の数字だけになる', () => {
    for (const r of [0, 0.000001, 0.5, 0.123456789, 0.9999999999]) {
      expect(digitName('/tmp/wne-', () => r)).toMatch(new RegExp(`^/tmp/wne-\\d{${TMP_DIGITS}}$`));
    }
    for (let i = 0; i < 1000; i++) expect(digitName('wne-')).toMatch(new RegExp(`^wne-\\d{${TMP_DIGITS}}$`));
    expect(digitName('wne-', () => 0)).toBe('wne-000000');
    expect(digitName('wne-', () => 0.9999999999)).toBe('wne-999999');
  });

  it('作ったディレクトリは数字だけの名前で、権限は 0700', () => {
    const dir = makeTmpDir(prefix());
    expect(basename(dir)).toMatch(new RegExp(`^wne-\\d{${TMP_DIGITS}}$`));
    const st = statSync(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('同じ名前がすでにあれば、名前を作り直す', () => {
    const p = prefix();
    const first = makeTmpDir(p, seq(0.123456));
    const second = makeTmpDir(p, seq(0.123456, 0.123456, 0.654321));
    expect(basename(first)).toBe('wne-123456');
    expect(basename(second)).toBe('wne-654321');
  });

  it('作れた名前が使えないと答えられたら、作ったディレクトリを消して名前を作り直す', () => {
    const p = prefix();
    const asked: string[] = [];
    const dir = makeTmpDir(p, seq(0.123456, 0.654321), d => {
      asked.push(basename(d));
      expect(existsSync(d)).toBe(true);
      return basename(d) === 'wne-123456';
    });
    expect(basename(dir)).toBe('wne-654321');
    expect(asked).toEqual(['wne-123456', 'wne-654321']);
    expect(existsSync(`${p}123456`)).toBe(false);
    // すでにある名前(EEXIST)は、使えるかを尋ねずに作り直す
    asked.length = 0;
    const next = makeTmpDir(p, seq(0.654321, 0.5), d => asked.push(basename(d)) < 0);
    expect(basename(next)).toBe('wne-500000');
    expect(asked).toEqual(['wne-500000']);
    // 使える名前が見つからなければ、ディレクトリを残さずに例外にする
    expect(() => makeTmpDir(p, seq(0.25), () => true)).toThrow(/could not create a temporary directory/);
    expect(existsSync(`${p}250000`)).toBe(false);
  });

  it('ソケット名に使うタグは、名前の数字の部分の全体になる', () => {
    expect(tmpTag(digitName('/tmp/wne-', () => 0.123456))).toBe('123456');
    expect(tmpTag('/private/tmp/wne-000042')).toBe('000042');
    for (let i = 0; i < 100; i++) expect(tmpTag(digitName('/tmp/wne-'))).toMatch(new RegExp(`^\\d{${TMP_DIGITS}}$`));
  });

  it('空きが見つからなければ例外にする。EEXIST 以外の失敗は、作り直さずにそのまま出す', () => {
    const p = prefix();
    makeTmpDir(p, seq(0.5));
    expect(() => makeTmpDir(p, seq(0.5))).toThrow(/could not create a temporary directory/);
    let calls = 0;
    const count = () => {
      calls++;
      return 0.5;
    };
    expect(() => makeTmpDir(join(p, 'no', 'such', 'parent-'), count)).toThrow(/ENOENT/);
    expect(calls).toBe(1);
  });
});
