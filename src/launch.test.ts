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
  const items = [
    { path: '/g/github.com/owner/tool', label: 'tool' },
    { path: '/g/github.com/a/bar', label: 'bar' },
    { path: '/g/github.com/a/owner-app', label: 'owner-app' },
  ];
  it('matches the full path too, with label matches first', () => {
    expect(filter(items, 'owner').map((c) => c.label)).toEqual(['owner-app', 'tool']);
  });
  it('matches the label loosely but the path only contiguously', () => {
    expect(filter(items, 'br').map((c) => c.label)).toEqual(['bar']);
    expect(filter(items, 'oa').map((c) => c.label)).toEqual(['owner-app']);
  });
});
