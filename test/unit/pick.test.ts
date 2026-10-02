import {describe, expect, it} from 'vitest';
import {parseArgs} from '../../src/cli/args.js';
import {displayNames, expandHome, filterIndexes, tildify} from '../../src/ops/pick.js';

describe('作業ディレクトリの候補 (シナリオ 8)', () => {
  it('末尾のディレクトリ名で出し、同じ名前があれば区別できるところまで親を足す', () => {
    expect(displayNames(['/a/foo', '/b/foo', '/c/bar'])).toEqual(['a/foo', 'b/foo', 'bar']);
    expect(displayNames(['/x/a/foo', '/y/a/foo'])).toEqual(['x/a/foo', 'y/a/foo']);
  });

  it('表示名は文字を順に含めば当たり、フルパスは続けて含むときだけ当たる。続けて当たるものを上に置く', () => {
    const items = [
      {name: 'whatnext', path: '/src/whatnext'},
      {name: 'web-app', path: '/src/web-app'},
      {name: 'tools', path: '/work/wapp/tools'},
    ];
    expect(filterIndexes(items, 'app')).toEqual([1, 2]);
    expect(filterIndexes(items, 'wn')).toEqual([0]);
    expect(filterIndexes(items, 'ext')).toEqual([0]);
    expect(filterIndexes(items, 'wp')).toEqual([1]);
    expect(filterIndexes(items, 'wapp')).toEqual([1, 2]);
    expect(filterIndexes(items, 'zz')).toEqual([]);
    expect(filterIndexes(items, '')).toEqual([0, 1, 2]);
  });

  it('~ を展開し、家のディレクトリを ~ で示す', () => {
    expect(expandHome('~/x', '/home/u')).toBe('/home/u/x');
    expect(tildify('/home/u/x', '/home/u')).toBe('~/x');
    expect(tildify('/tmp', '/home/u')).toBe('/tmp');
  });
});

describe('引数 (シナリオ 42)', () => {
  it('--help は先頭のときだけ。workbench のあとの引数は知らないオプション', () => {
    expect(parseArgs([])).toEqual({kind: 'list'});
    expect(parseArgs(['--help'])).toEqual({kind: 'help'});
    expect(parseArgs(['workbench'])).toEqual({kind: 'workbench'});
    expect(parseArgs(['workbench', '--help'])).toEqual({kind: 'unknown', arg: '--help'});
    expect(parseArgs(['x', '--help'])).toEqual({kind: 'unknown', arg: 'x'});
    expect(parseArgs(['-h'])).toEqual({kind: 'unknown', arg: '-h'});
  });
});
