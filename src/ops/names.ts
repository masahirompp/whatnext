// 一覧と起動の口(cli)が共有する、専用サーバのオプションの名前と案内の中身。依存は cli → 操作の向きだけにする。

/** whatnext の画面のクライアントの tty(`whatnext` が置く)。 */
export const MAIN_TTY = '@wn_main_tty';
/** 作業台の画面のクライアントの tty(`whatnext workbench` が置く)。 */
export const WB_TTY = '@wn_wb_tty';
/** 動いている一覧と違う版で起動したときの、起動した版。 */
export const NEWER = '@wn_newer';
/** 作業台の画面の案内に出すもの(JSON の GuideState)。 */
export const GUIDE_OPTION = '@wn_guide';

export type GuideState =
  | {kind: 'none'; name: string; path: string; closed?: boolean}
  | {kind: 'tty'; name: string}
  | {kind: 'empty'};
