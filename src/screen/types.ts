// 画面の組み立てが受け取る形。ほかのモジュールの型は import しない(DESIGN.md「モジュールの境界」)。

export type Tone = 'permission' | 'question' | 'sandbox' | 'failed' | 'review' | 'working' | 'waiting' | 'stopped';

export interface ScreenRow {
  sid: string;
  name: string;
  /** 名前に添える印。 */
  marker?: 'tty' | 'sub';
  /** STATUS の列の文字列(`Question (blocked)`、`Stopping...` など)。 */
  status: string;
  tone: Tone;
  where: {
    /** 区切りと違うリポジトリのときだけのリポジトリ名。 */
    repo?: string;
    sub?: string;
    branch?: string;
    worktree?: boolean;
    pr?: {number: number; state: 'open' | 'draft' | 'merged' | 'closed'};
  };
  ctx?: number;
  /** 作ってからの時間(ミリ秒)。 */
  age?: number;
  /** ダイジェストの Goal(`◎ <Goal>` の行。ダイジェストが有効なときだけ)。 */
  goal?: string;
  /** 一言。 */
  line?: string;
  /** 作業台で動いているもの。 */
  running?: string[];
  note?: string;
  /** 削除している間(行全体を薄くする)。 */
  deleting?: boolean;
  // 入れ子の線
  depth: number;
  last: boolean;
  ancestorsLast: boolean[];
  hasChildren: boolean;
}

export interface ScreenGroup {
  title: string;
  rows: ScreenRow[];
}

/** 一覧の右の欄(カーソルの行のダイジェストと会話リンク。ダイジェストが有効なときだけ)。 */
export interface Side {
  /** カーソルの行のセッション名。 */
  title: string;
  digest?: {goal: string; progress: string; next: string};
  /** リンク(新しいもの順)。`href` は受け口が検査した http(s) の URL で、埋め込みのリンク(OSC 8)にする。 */
  links: {label: string; href: string}[];
  /** ダイジェストが届かない理由(受け口を開けなかったとき)。あれば「まだない」の文言の代わりに出す。 */
  off?: string;
}

export interface Screen {
  width: number;
  height: number;
  groups: ScreenGroup[];
  cursor?: string;
  /** 行が1件もないとき、`--json` を読めなかったときの文言(一覧の代わりに出す)。 */
  message?: string;
  /** メモの入力欄(その行と注記の直下に出し、`↳ <メモ>` の行を置き換える)。 */
  inline?: {sid: string; lines: string[]};
  /** 一覧のすぐ下(1行空けて)に出す入力欄とメニュー。 */
  panel?: string[];
  /** 知らせ(入力欄の下、なければ一覧の下に1行空けて)。 */
  notice?: string[];
  usage?: string;
  /** キーの説明。端末の幅に収まらなければ、区切りで折り返して複数行で出す。 */
  keys?: string;
  /** キーの説明を出さず、その行数だけ空ける(メニューや入力欄を開いている間。Usage の位置を変えない)。 */
  keysHidden?: boolean;
  side?: Side;
}
