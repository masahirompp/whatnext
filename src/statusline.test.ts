import { describe, expect, it } from 'vitest';
import { parseStatusline, summarizeSession, summarizeWhere } from './statusline.js';

// 公式ドキュメントのスキーマと、実測(2.1.281, haiku)を模した statusline の JSON
const haiku = {
  session_id: 's1',
  model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
  thinking: { enabled: true },
  context_window: { context_window_size: 200000, used_percentage: 18 },
  workspace: { current_dir: '/w/whatnext', git_worktree: undefined },
};

const git = (branch: string | null, worktree = false, defaultBranch: string | null = 'main') => ({ repo: 'whatnext', branch, worktree, defaultBranch });

describe('SESSION の要約', () => {
  it('モデル、コンテキストの割合、effort の順にまとめる', () => {
    const s = parseStatusline({ ...haiku, model: { display_name: 'Opus' }, effort: { level: 'high' } }, 0);
    expect(summarizeSession(s)).toBe('Opus 18% high');
  });

  it('effort がないモデルは effort を省く。thinking が無効なら no-think と出す', () => {
    expect(summarizeSession(parseStatusline(haiku, 0))).toBe('Haiku 4.5 18%');
    expect(summarizeSession(parseStatusline({ ...haiku, thinking: { enabled: false } }, 0))).toBe('Haiku 4.5 18% no-think');
  });

  it('タップの記録がないセッションは空欄', () => {
    expect(summarizeSession(null)).toBe('');
  });
});

describe('WHERE の要約', () => {
  it('既定のブランチならリポジトリ名だけ', () => {
    expect(summarizeWhere(git('main'), '/w', null).text).toBe('whatnext');
  });

  it('既定でないブランチは repo:branch', () => {
    expect(summarizeWhere(git('feat/x'), '/w', null).text).toBe('whatnext:feat/x');
  });

  it('origin/HEAD が分からなければ main と master を既定とみなす', () => {
    expect(summarizeWhere(git('master', false, null), '/w', null).text).toBe('whatnext');
    expect(summarizeWhere(git('develop', false, null), '/w', null).text).toBe('whatnext:develop');
  });

  it('worktree なら (wt) を付け、Claude の worktree ならセッション自身のブランチを使う', () => {
    const s = parseStatusline({ ...haiku, worktree: { name: 'x', branch: 'worktree-x', original_branch: 'main' } }, 0);
    expect(summarizeWhere(git('main', true), '/w', s).text).toBe('whatnext:worktree-x (wt)');
  });

  it('PR は statusline の pr から取る', () => {
    const s = parseStatusline({ ...haiku, pr: { number: 12, url: 'u', review_state: 'approved' } }, 0);
    expect(summarizeWhere(git('feat/x'), '/w', s).pr).toEqual({ number: 12, review: 'approved', mr: false });
  });

  it('git でない場所はパスをそのまま出す', () => {
    expect(summarizeWhere(null, '~/tmp/x', null).text).toBe('~/tmp/x');
  });
});
