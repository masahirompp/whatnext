import { describe, expect, it } from 'vitest';
import { summarizeWhere, type GitInfo } from './gitinfo.js';

const g = (branch: string | null, worktree = false, defaultBranch: string | null = 'main'): GitInfo => ({
  repo: 'whatnext',
  top: '/w/whatnext',
  branch,
  worktree,
  defaultBranch,
});

describe('WHERE の要約', () => {
  it('既定のブランチならリポジトリ名だけ', () => {
    expect(summarizeWhere(g('main'), '/w')).toBe('whatnext');
  });

  it('既定でないブランチは repo:branch', () => {
    expect(summarizeWhere(g('feat/x'), '/w')).toBe('whatnext:feat/x');
  });

  it('origin/HEAD が分からなければ main と master を既定とみなす', () => {
    expect(summarizeWhere(g('master', false, null), '/w')).toBe('whatnext');
    expect(summarizeWhere(g('develop', false, null), '/w')).toBe('whatnext:develop');
  });

  it('worktree なら (wt) を付ける', () => {
    expect(summarizeWhere(g('worktree-x', true), '/w')).toBe('whatnext:worktree-x (wt)');
  });

  it('git でない場所はパスをそのまま出す', () => {
    expect(summarizeWhere(null, '~/tmp/x')).toBe('~/tmp/x');
  });
});
