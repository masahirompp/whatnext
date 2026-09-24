// statusline のタップが保存した JSON(#15)を読み、行の表示用に要約する。
// 使うのは公式ドキュメントに載っているフィールドだけ: https://code.claude.com/docs/en/statusline
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function statuslineDir(): string {
  if (process.env.WHATNEXT_STATUSLINE_DIR) return process.env.WHATNEXT_STATUSLINE_DIR;
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cache, 'whatnext', 'statusline');
}

export type ReviewState = 'approved' | 'pending' | 'changes_requested' | 'draft';

export type SessionInfo = {
  model?: string;
  effort?: string;
  thinking?: boolean;
  contextPct?: number;
  pr?: { number: number; review?: ReviewState; mr: boolean };
  worktreeBranch?: string;
  inWorktree: boolean;
  savedAt: number;
};

export function parseStatusline(json: any, savedAt: number): SessionInfo {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const prNumber = num(json?.pr?.number);
  return {
    model: str(json?.model?.display_name) ?? str(json?.model?.id),
    effort: str(json?.effort?.level),
    thinking: typeof json?.thinking?.enabled === 'boolean' ? json.thinking.enabled : undefined,
    contextPct: num(json?.context_window?.used_percentage),
    pr: prNumber === undefined ? undefined : { number: prNumber, review: str(json.pr.review_state) as ReviewState | undefined, mr: json.pr.kind === 'mr' },
    worktreeBranch: str(json?.worktree?.branch),
    inWorktree: !!json?.worktree || !!json?.workspace?.git_worktree,
    savedAt,
  };
}

export function readSessionInfo(sessionId: string): SessionInfo | null {
  const file = path.join(statuslineDir(), `${sessionId}.json`);
  try {
    const stat = fs.statSync(file);
    return parseStatusline(JSON.parse(fs.readFileSync(file, 'utf8')), stat.mtimeMs);
  } catch {
    return null;
  }
}

// モデル、コンテキスト、effort(thinking)を短くまとめる。例: "Opus 18% high"
export function summarizeSession(s: SessionInfo | null): string {
  if (!s) return '';
  const parts: string[] = [];
  // 列の幅で切れたときに大事なものが残るよう、モデル、コンテキスト、effort の順に並べる
  if (s.model) parts.push(s.model);
  if (s.contextPct !== undefined) parts.push(`${Math.round(s.contextPct)}%`);
  if (s.effort) parts.push(s.effort);
  else if (s.thinking === false) parts.push('no-think');
  return parts.join(' ');
}

export type Where = { text: string; pr?: SessionInfo['pr'] };

// リポジトリ、ブランチ、worktree、PR を1つにまとめる。既定のブランチは省く。
//   whatnext / whatnext:feat/x / whatnext:feat/x (wt) #12
export function summarizeWhere(
  git: { repo: string; branch: string | null; worktree: boolean; defaultBranch: string | null } | null,
  cwd: string,
  s: SessionInfo | null,
): Where {
  if (!git) return { text: cwd, pr: s?.pr };
  // Claude が作った worktree のセッションなら、そのセッション自身のブランチを使う
  const branch = s?.worktreeBranch ?? git.branch;
  const isDefault = branch !== null && (git.defaultBranch ? branch === git.defaultBranch : branch === 'main' || branch === 'master');
  let text = git.repo;
  if (branch && !isDefault) text += `:${branch}`;
  if (git.worktree || s?.inWorktree) text += ' (wt)';
  return { text, pr: s?.pr };
}
