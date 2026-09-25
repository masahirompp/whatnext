import { describe, expect, it } from 'vitest';
import { openTargets, vscodeDevUrl, vscodeFolderUrl } from './where.js';

describe('open targets', () => {
  it('maps a GitHub PR to vscode.dev', () => {
    expect(vscodeDevUrl('https://github.com/o/r/pull/12')).toBe('https://vscode.dev/github/o/r/pull/12');
    expect(vscodeDevUrl('https://ghe.example.com/o/r/pull/12')).toBeNull();
  });

  it('builds a VS Code folder URL', () => {
    expect(vscodeFolderUrl('/a/my repo')).toBe('vscode://file/a/my%20repo/');
  });
});

describe('openTargets', () => {
  const git = { top: '/r/.claude/worktrees/w', repoRoot: '/r', repo: 'r', sub: 'sub', branch: 'feat', worktree: true };
  it('opens the worktree, then the PR on vscode.dev and GitHub', () => {
    expect(openTargets('/r/.claude/worktrees/w/sub', git, { number: 3, state: 'open', url: 'https://github.com/o/r/pull/3' })
      .map((t) => t.url)).toEqual([
      'vscode://file/r/.claude/worktrees/w/', 'https://vscode.dev/github/o/r/pull/3', 'https://github.com/o/r/pull/3',
    ]);
  });
  it('offers only VS Code without a PR, at the cwd outside git', () => {
    expect(openTargets('/tmp/x', null, null).map((t) => t.url)).toEqual(['vscode://file/tmp/x/']);
  });
});
