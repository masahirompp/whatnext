// 操作: 外部に頼む作業の口。cli が本物を、テストが偽物を差し込む。

import type {AgentsResult, UsageFrame} from '../input/claude.js';
import type {RunResult} from '../input/exec.js';
import type {Supplied} from '../input/hooks.js';
import type {Place, PullRequest} from '../input/place.js';
import type {Relations} from '../state/store.js';
import type {GhosttyResult} from '../tmux/ghostty.js';
import type {Client, MenuItem} from '../tmux/tmux.js';

export interface Observed {
  sup: Supplied;
  /** 作業したかの判定に使う数(UserPromptSubmit の数と、会話記録の user と assistant の行の数の和)。 */
  activity: number;
}

export interface TmuxPort {
  clients(): Promise<Client[]>;
  sessions(): Promise<string[]>;
  takeRequests(): Promise<string[]>;
  option(name: string): Promise<string | undefined>;
  setOption(name: string, value: string): Promise<void>;
  unsetOption(name: string): Promise<void>;
  switchClient(tty: string, target: string): Promise<boolean>;
  killSession(name: string): Promise<void>;
  killServer(): Promise<void>;
  display(tty: string, text: string, ms?: number): Promise<void>;
  menu(tty: string, title: string, items: MenuItem[]): void;
  reqCommand(args: string): string;
  ensureClaudeSession(id: string, cwd: string, size: {cols: number; rows: number}): Promise<boolean>;
  setSummary(id: string, text: string): Promise<void>;
  createWorkbench(id: string, cwd: string, name: string): Promise<boolean>;
  setSessionName(session: string, name: string): Promise<void>;
  running(): Promise<Map<string, string[]>>;
  newTrustSession(dir: string): Promise<string | undefined>;
  /** 案内のセッションのプログラムに描き直しを知らせる。 */
  signalGuide(): Promise<void>;
}

export interface Ports {
  now(): number;
  readAgents(): Promise<AgentsResult>;
  observe(rows: readonly {sessionId: string}[]): Promise<Map<string, Observed>>;
  place(cwd: string): Promise<Place>;
  pullRequest(cwd: string, branch: string): Promise<PullRequest | undefined>;
  usage(): Promise<UsageFrame[] | undefined>;
  firstPrompt(sid: string, force?: boolean): Promise<string | undefined>;
  ghqList(): Promise<string[]>;
  isDirectory(path: string): Promise<boolean>;
  trusted(dir: string): Promise<boolean>;
  stop(id: string): Promise<RunResult>;
  remove(id: string, discard?: string): Promise<RunResult>;
  launch(dir: string, model?: string): Promise<RunResult>;
  open(target: string): Promise<RunResult>;
  saveState(r: Relations): void;
  tmux: TmuxPort;
  ghosttyFocus(): Promise<GhosttyResult>;
  ghosttySplit(): Promise<GhosttyResult>;
  size(): {cols: number; rows: number};
  write(s: string): void;
  /** 一覧を終える(tmux サーバごと閉じたあと)。 */
  exit(): void;
  /** 一定時間後に呼ぶ。テストでは時計を進めて呼ぶ。 */
  setTimer(fn: () => void, ms: number): {cancel(): void};
  home: string;
  startDir: string;
}
