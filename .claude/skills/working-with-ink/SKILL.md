---
name: working-with-ink
description: Ink(React の端末 UI)で whatnext の画面・キー入力・子プロセスへの端末の明け渡しを実装するときに読む。Ink 7 の API の使い方と罠。
---
# Ink で実装するときの罠

## 端末を子プロセスに明け渡す(attach)
- Ink 7 の `useApp().suspendTerminal(callback)` を使う。代替画面を出て、raw モードとブラケットペーストを戻し、入力の listener を外し、callback のあとで全体を描き直す。この中で `spawn(..., {stdio: 'inherit'})` を動かせば、キー入力の二重配送も端末設定の残骸も起きなかった(Ink 7.1.1、tmux 上で実測)。
- 子が raw モードに入る前に届くシグナルに備え、明け渡している間だけ SIGINT / SIGTSTP / SIGQUIT を無視する。
- Ink 7.1.1 の `pauseInput` は raw モードを解除して `unref` するだけで、`readable` の listener を外さない。Node は tty の読み取りを続け、子に届くはずの最初の入力の塊を横取りする（attach の最初の Ctrl+Z が効かない、子への端末の応答が whatnext に届く）。さらに attach は Ink の `readable` ハンドラの中から同期的に始まるので、その場で `readStop()` してもハンドラの `stdin.read()` のループが読み取りを再開する。次の3点を揃えると止まる（10回連続で確認）。
  1. suspendTerminal のコールバックの先頭で `setImmediate` を1回待ち、Ink のハンドラを抜ける
  2. `readable` の listener をすべて外し、`_handle.reading = false` にして `_handle.readStop()`
  3. 子の終了後に `_readableState.reading = false` に戻し、listener を付け直して `stdin.read(0)` で読み取りを再開する

  Node の内部 API（`_handle`、`_readableState`）に触るので、Node の更新で壊れうる。
- 子が raw のまま異常終了すると、`setRawMode(false)` では端末が戻らない。libuv は cooked → raw に移るたびにその時点の termios を「元の状態」として保存し直し、raw → cooked で書き戻す。モードが既に cooked なら `setRawMode(false)` は何もしないので、子の終了後にトグルしても壊れた termios を書き戻すだけになる。子を起動する前（端末が正常なうち）に設定を保存し、終了後に書き戻す。`stty -g` で保存して `stty <保存値>` で戻す方法と、子の前に `setRawMode(true)` で libuv に正常な termios を保存させる方法の両方が、偽の claude（代替画面・マウス追跡・カーソル非表示・`stty raw` を残して exit 1）で効いた。
- 子が代替画面の中でメッセージを出して異常終了すると、端末を戻して代替画面を抜けた瞬間にメッセージが消える。0 以外の終了では、代替画面以外（マウス追跡、フォーカスイベント、ブラケットペースト、カーソル表示、kitty キーボード、modifyOtherKeys）を先に戻し、キーが押されてから代替画面を抜ける。実物の `claude attach` の `Couldn't wake` が代替画面の中に出るかは未確認。

## React の state 更新
- `setState(updater)` の updater は、次の描画まで遅れて呼ばれることがある。updater の中で外の変数に代入したり副作用を起こしたりすると、`await` の直後にはまだ実行されておらず、値を読めない。結果を呼び出し元で使いたいときは、updater の外で計算して返り値で渡す(例: 一覧を読み直す関数が、読めた一覧を返す)。
- `useInput` のハンドラは、描画した時点の state を閉じ込めている。同じ描画のうちに届いた複数のキー（tmux の send-keys や貼り付けで一度に届くもの）は、前のキーによる state の更新を読めない（例：メニューで `↓` の直後の `Enter` が、`↓` の前の選択位置を開く）。キーをまたいで読む値（選択位置、モード）は `useRef` にも持ち、ハンドラの中では ref を読み書きする。モードを切り替えるキー（メニューを開くなど）の直後に同じ塊で届いたキーは、まだ前のモードで処理される。人の手の速さでは起きない。

## キー入力と貼り付けの受け方(Ink 7、ソースで確認)
- `\r` は `key.return`。`\x1b\r`(Option+Enter)は `key.return` かつ `key.meta`。`\n`(Ctrl+J)は `key.return` にならず、`input` が `'\n'` のまま届く。
- 貼り付けは、`usePaste` がなければ1回の `input` として `useInput` に届く(改行を含むことがある)。`usePaste` を使っている間だけ bracketed paste が有効になり、貼り付けは `usePaste` にだけ届いて `useInput` には来ない。
- 1行の入力欄では、貼り付けに含まれる改行や `\r` を取り除いてから使う。
