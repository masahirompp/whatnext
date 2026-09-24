import { describe, expect, it } from 'vitest';
import { filter, shortLabels } from './launch.js';

describe('shortLabels', () => {
  it('shows only the repo name when unique', () => {
    expect(shortLabels(['/g/github.com/a/foo', '/g/github.com/a/bar'])).toEqual(['foo', 'bar']);
  });
  it('widens only colliding names, just enough to tell them apart', () => {
    expect(shortLabels(['/g/github.com/a/foo', '/g/github.com/b/foo', '/g/github.com/a/bar']))
      .toEqual(['a/foo', 'b/foo', 'bar']);
    expect(shortLabels(['/g/github.com/a/foo', '/g/gitlab.com/a/foo']))
      .toEqual(['github.com/a/foo', 'gitlab.com/a/foo']);
  });
  it('falls back to the full path when one path is a suffix of another', () => {
    expect(shortLabels(['/a/foo', '/x/a/foo'])).toEqual(['/a/foo', '/x/a/foo']);
  });
});

describe('filter', () => {
  it('matches on the label, not the full path', () => {
    const items = [{ path: '/g/github.com/a/foo', label: 'foo' }, { path: '/g/github.com/a/bar', label: 'bar' }];
    expect(filter(items, 'git')).toEqual([]);
    expect(filter(items, 'br').map((c) => c.label)).toEqual(['bar']);
  });
});
