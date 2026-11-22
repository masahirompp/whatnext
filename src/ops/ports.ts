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
  /** 一覧の自動の更新の間隔(ms)。 */
  refreshMs: number;
  /** Usage を取り直す最短の間隔(ms)。 */
  usageMinMs: number;
  /** 一覧の端末に書く。 */
  write: (s: string) => void;
  size: () => {cols: number; rows: number};
  /** `n` で起動するセッションの `--settings`(受け口を開けていなければ undefined)。 */
  settings?: string;
  /** `n` で起動するセッションに `--plugin-dir` で付けるダイジェストの mod(`--digest` で受け口を開けたときだけ)。 */
  pluginDir?: string;
  /** `--digest` で動いているか。 */
  digest: boolean;
  /** `--digest` で動いているのに受け口を開けなかった理由(右の欄に出す英語の文言)。開けたときは undefined。 */
  digestOff?: string;
  socket: string;
  port: number;
  version: string;
  /** `whatnext workbench` を動かすコマンド(Ghostty の分割に打ち込む)。 */
  workbenchCommand: string;
  /** 案内のプログラムを動かすコマンド(案内のセッションが消えていたら、一覧がこれで作り直す)。 */
  guideCommand: string;
  /** whatnext を起動したディレクトリ。 */
  launchDir: string;
  /** `~/.claude.json` の置き場所(`CLAUDE_CONFIG_DIR` があればその下)。 */
  claudeJson: string;
  home: string;
  log: (msg: string) => void;
  exit: (code: number) => void;
}
