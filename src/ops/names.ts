// 一覧と起動の口(cli)が共有する、専用サーバのオプションの名前と案内の中身。依存は cli → 操作の向きだけにする。

/** whatnext の画面のクライアントの tty(`whatnext` が置く)。 */
export const MAIN_TTY = '@wn_main_tty';
/** 作業台の画面のクライアントの tty(`whatnext workbench` が置く)。 */
export const WB_TTY = '@wn_wb_tty';
/** 動いている一覧と違う版で起動したときの、起動した版。 */
export const NEWER = '@wn_newer';
/**
 * 一覧がダイジェストを有効にして動いているか(`1` か `0`。一覧が、一覧のセッション `list` のオプションに置く)。
 * `whatnext --no-digest` は、これが `1` の一覧にはつながずに断る(PRODUCT.md「ダイジェスト」)。`@wn_digest_port` と同じ理由で
 * セッションのオプションにする(一覧のプロセスがどう終わっても、一覧のセッションごと消える)。
 * 0.24 の一覧は、`--digest` のときだけ同じ名前をサーバ全体のオプションに `1` で置いた。一覧のセッションに値がないとき
 * (0.24 までの一覧)は、起動の口がそれを読む。
 */
export const DIGEST_ON = '@wn_digest';
/**
 * 0.24 の `whatnext --digest` が、`--digest` なしの一覧につないだときに置いたオプション(`1`)。0.24 の一覧は、これがある間
 * 「`whatnext --digest` で起動し直せ」と知らせる。今の版は置かず、読まない。`--digest` は消したので、0.24 の一覧に
 * つなぐときに起動の口が外す(移行のためだけに名前を残す)。
 */
export const LEGACY_DIGEST_WANTED = '@wn_digest_wanted';
/**
 * ダイジェストを受けている受け口のポート(一覧がダイジェストを有効にして受け口を開けたときだけ、一覧のセッション `list` のオプションに
 * 置く)。mod はターンの終わりにこれを読み、自分の送り先のポートと同じときだけ Haiku を呼ぶ(DESIGN.md「ダイジェストの mod」)。
 * 一覧のプロセスが終わると一覧のセッションごと消えるので、作業台のためにサーバが残っても受けているとは読まれない。
 */
export const DIGEST_LIVE = '@wn_digest_port';
/** 作業台の画面の案内に出すもの(JSON の GuideState)。 */
export const GUIDE_OPTION = '@wn_guide';

export type GuideState =
  | {kind: 'none'; name: string; path: string; closed?: boolean}
  | {kind: 'tty'; name: string}
  | {kind: 'empty'};
