---
name: working-with-ink
description: Ink(React の端末 UI)で whatnext の画面・キー入力・子プロセスへの端末の明け渡しを実装するときに読む。Ink 7 の API の使い方と罠。
---
# Ink で実装するときの罠

## 端末を子プロセスに明け渡す(attach)
- Ink 7 の `useApp().suspendTerminal(callback)` を使う。代替画面を出て、raw モードとブラケットペーストを戻し、入力の listener を外し、callback のあとで全体を描き直す。この中で `spawn(..., {stdio: 'inherit'})` を動かせば、キー入力の二重配送も端末設定の残骸も起きなかった(Ink 7.1.1、tmux 上で実測)。
- 子が raw モードに入る前に届くシグナルに備え、明け渡している間だけ SIGINT / SIGTSTP / SIGQUIT を無視する。
- listener を外しても Node が tty の読み取りを続けて入力を横取りしうる。防御として `process.stdin._handle.readStop()` を呼んでもよいが、実測では有無で差は出なかった。内部 API なので、Node の更新で壊れたら外す。
- 子の異常終了時の端末の状態は未確認。

## React の state 更新
- `setState(updater)` の updater は、次の描画まで遅れて呼ばれることがある。updater の中で外の変数に代入したり副作用を起こしたりすると、`await` の直後にはまだ実行されておらず、値を読めない。結果を呼び出し元で使いたいときは、updater の外で計算して返り値で渡す(例: 一覧を読み直す関数が、読めた一覧を返す)。

## キー入力と貼り付けの受け方(Ink 7、ソースで確認)
- `\r` は `key.return`。`\x1b\r`(Option+Enter)は `key.return` かつ `key.meta`。`\n`(Ctrl+J)は `key.return` にならず、`input` が `'\n'` のまま届く。
- 貼り付けは、`usePaste` がなければ1回の `input` として `useInput` に届く(改行を含むことがある)。`usePaste` を使っている間だけ bracketed paste が有効になり、貼り付けは `usePaste` にだけ届いて `useInput` には来ない。
- 1行の入力欄では、貼り付けに含まれる改行や `\r` を取り除いてから使う。
