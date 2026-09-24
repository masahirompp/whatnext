import { describe, expect, it } from 'vitest';
import { fuzzyFilter } from './fuzzy.js';

const repos = [
  '/Users/me/ghq/github.com/me/whatnext',
  '/Users/me/ghq/github.com/me/poc-piano',
  '/Users/me/ghq/github.com/me/poc-media',
  '/Users/me/ghq/github.com/me/life',
];

describe('fuzzyFilter', () => {
  it('returns every candidate in order for an empty query', () => {
    expect(fuzzyFilter(repos, '')).toEqual(repos);
  });

  it('keeps only candidates that contain the letters in order', () => {
    expect(fuzzyFilter(repos, 'wnx')).toEqual([repos[0]]);
    expect(fuzzyFilter(repos, 'zzz')).toEqual([]);
  });

  it('puts a contiguous match above a scattered one', () => {
    expect(fuzzyFilter(repos, 'pia')[0]).toBe(repos[1]);
  });

  it('prefers matches near the end of the path', () => {
    const list = ['/work/life/other', '/work/other/life'];
    expect(fuzzyFilter(list, 'life')).toEqual(['/work/other/life', '/work/life/other']);
  });

  it('ignores case and spaces', () => {
    expect(fuzzyFilter(repos, 'POC med')).toEqual([repos[2]]);
  });
});
