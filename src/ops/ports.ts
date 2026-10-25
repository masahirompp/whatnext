import type {UsageFrame} from '../../lib/input/claude.js';
import type {Run} from '../../lib/input/exec.js';
import type {HookStore} from '../../lib/input/hooks.js';
import type {Transcripts} from '../../lib/input/transcript.js';
import type {Tmux} from '../../lib/tmux/tmux.js';
import type {Observer} from '../input/observe.js';
import type {Locations, Prs} from '../input/where.js';
import type {StateFile} from '../state/state.js';

// 操作が外部に頼む作業の口(DESIGN.md「モジュールの境界」)。cli が本物を差し込む。

export interface Ports {
  run: Run;
  tmux: Tmux;
  observer: Observer;
  locations: Locations;
  prs: Prs;
  transcripts: Transcripts;
  hooks: HookStore;
  stateFile: StateFile;
  fetchUsage: () => Promise<UsageFrame[] | undefined>;
  now: () => number;
  /** 一覧の端末に書く。 */
  write: (s: string) => void;
  size: () => {cols: number; rows: number};
  /** `n` で起動するセッションの `--settings`(受け口を開けていなければ undefined)。 */
  settings?: string;
  socket: string;
  port: number;
  version: string;
  /** `whatnext workbench` を動かすコマンド(Ghostty の分割に打ち込む)。 */
  workbenchCommand: string;
  /** whatnext を起動したディレクトリ。 */
  launchDir: string;
  /** `~/.claude.json` の置き場所(`CLAUDE_CONFIG_DIR` があればその下)。 */
  claudeJson: string;
  home: string;
  log: (msg: string) => void;
  exit: (code: number) => void;
}
