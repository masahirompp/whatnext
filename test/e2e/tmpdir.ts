import {mkdirSync} from 'node:fs';

// 画面の通しの一時ディレクトリの名前。tmux に依らないので、振る舞いを単体のテスト(test/unit/e2e-tmpdir.test.ts)で
// 確かめる(#382)。

/** 名前の末尾に付ける数字の桁数。`mkdtemp` の乱数と同じ 6 文字にして、パスの長さを変えない。 */
export const TMP_DIGITS = 6;

/** `prefix` に `TMP_DIGITS` 桁の数字を続けた名前を返す。`random` は 0 以上 1 未満を返す。 */
export function digitName(prefix: string, random: () => number = Math.random): string {
  const n = Math.floor(random() * 10 ** TMP_DIGITS);
  return prefix + String(n).padStart(TMP_DIGITS, '0');
}

/**
 * 名前の数字の部分(末尾の `TMP_DIGITS` 桁)。harness はこれを tmux のソケット名に使う。桁数を `TMP_DIGITS` から
 * 取るので、桁数を変えても、数字の部分の違うディレクトリが同じソケット名になることはない。
 */
export function tmpTag(dir: string): string {
  return dir.slice(-TMP_DIGITS);
}

/**
 * `prefix` に数字だけを続けた名前のディレクトリを作り、そのパスを返す。権限は `mkdtemp` と同じ 0700。
 *
 * `mkdtemp` を使わないのは、その乱数が英数字で、`n` の欄などの絞り込みの入力(`zq`、`gr` など)が乱数の中に並ぶと、
 * フルパスで当たった余計な候補が残ってテストが落ちるため(絞り込みは、小文字にしたフルパスに入力が続けて含まれれば
 * 当てる)。数字だけなら、文字の入力には当たらない。逆に、数字の入力には前より当たりやすい(1 字なら約 47%)ので、
 * 画面の通しでは、絞り込みの入力(`n` の欄、待ち先のメニューなど)に数字を使わない。
 *
 * 同じ名前がすでにあれば(`EEXIST`)、名前を作り直す。`mkdir` は「無ければ作る」を一度に行うので、並行に流れる
 * テストファイルが同じ名前を選んでも、作れるのは片方だけになる。
 */
export function makeTmpDir(prefix: string, random: () => number = Math.random): string {
  for (let i = 0; i < 100; i++) {
    const dir = digitName(prefix, random);
    try {
      mkdirSync(dir, {mode: 0o700});
      return dir;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`could not create a temporary directory under ${prefix}`);
}
