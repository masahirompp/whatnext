// 段と並びが受け取る行と返す並び。ほかのモジュールの型は import しない(DESIGN.md「モジュールの境界」)。

export type Tier = 'permission' | 'question' | 'sandbox' | 'failed' | 'review' | 'working' | 'waiting' | 'stopped';

/** `--json` の1行(重複を除いたもの)。対象外の行も含めて渡す。 */
export interface Row {
  sid: string;
  /** `background` の行だけが持つ。 */
  id?: string;
  kind: 'background' | 'interactive';
  name: string;
  /** 行そのものの段。null は対象外(一覧に出さない)。待ちの段はここでは持たない。 */
  tier: Tier | null;
  /** リポジトリの区切りの根(絶対パス)。 */
  group: string;
}

export interface Times {
  /** 一覧に初めて出た時刻(ミリ秒)。 */
  first?: number;
  /** whatnext から最後に attach した時刻(ミリ秒)。 */
  attached?: number;
}

export interface Inputs {
  rows: readonly Row[];
  /** 状態のファイルの待ち先の関係(待ち元 → 待ち先)。木にならない関係も含みうる。 */
  waits: ReadonlyMap<string, readonly string[]>;
  /** 起動された行 → 起動元(起動元は対象外の行のこともある)。 */
  spawner: ReadonlyMap<string, string>;
  times: ReadonlyMap<string, Times>;
}

export interface Node {
  sid: string;
  depth: number;
  /** 兄弟の最後か(線の `└`)。 */
  last: boolean;
  /** 祖先(深さ1から自分の親まで)のそれぞれが兄弟の最後か。注記の縦線を引くのに使う。 */
  ancestorsLast: boolean[];
  /** 子(入れ子の下の行)があるか。 */
  hasChildren: boolean;
  /** 起動された行か(`(sub)`)。 */
  spawned: boolean;
}

export interface Group {
  /** 区切りの根(絶対パス)。 */
  root: string;
  /** 見出しの名前。 */
  title: string;
  nodes: Node[];
}

export interface Layout {
  groups: Group[];
  /** 表示の順の sessionId。 */
  order: string[];
  /** 入れ子の親(待ち元か起動元)。トップレベルの行は持たない。 */
  parent: Map<string, string>;
  /** 一覧に出る行の段(待ちの段を導いたあと)。 */
  tier: Map<string, Tier>;
}
