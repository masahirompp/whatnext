---
name: driving-whatnext-in-tmux
description: whatnext の画面を実機で確かめるとき(キー操作、attach と離脱、表示の確認)に読む。tmux の中で起動し、send-keys で操作して capture-pane で画面をテキストで取る手順と注意点。
---
# tmux で whatnext の画面を操作して確かめる

ビルドしてから、入口(`package.json` の `bin`。サイクル2では `dist/cli.js`)を tmux の中で起動する。

```sh
tmux new-session -d -s wn -x 110 -y 20 'node dist/cli.js'
sleep 6                                  # 最初の --json と Usage を待つ
tmux send-keys -t wn h                   # 1キー
tmux send-keys -t wn -l 'some text'      # 文字列はそのまま(-l がないと単語がキー名として解釈されうる)
tmux send-keys -t wn Enter               # background の行なら claude attach に入る
tmux send-keys -t wn C-z                 # attach から離脱して一覧に戻る
tmux capture-pane -p -t wn               # 画面をテキストで取る
tmux kill-session -t wn                  # 片付け
```

- attach 中の capture-pane では Claude Code の画面がそのまま取れ、本当に attach したかを確かめられる。
- 離脱後、一覧が描き直されるまで数秒かかる(`--json` の読み直し)。capture の前に待つ。
- 既存のセッションに attach するので、何も入力しなければ相手のセッションは変わらない。
- 1回の send-keys で複数のキーを送ると同じ塊で届き、人の手では起きない順序の問題が出る(working-with-ink スキルの useInput の項)。人の操作を再現するときは1キーずつ送る。
- zsh では `T="tmux send-keys -t wn"; $T Up` が単語分割されず、`command not found` になる。キーを送る処理はシェル関数にする(例: `k() { for x in "$@"; do tmux send-keys -t wn "$x"; sleep 0.25; done; }`)。
- 保留の理由などの入力欄が開いていると、↑↓ は入力欄に吸われ、そのあとの Enter が別の行の操作を確定させる(実際に別のセッションを保留にした)。カーソルを名前で合わせる関数(上に戻してから下へ送り、`capture-pane` で `^> .*<名前>` を探す)を使うときも、操作のあとは入力欄が閉じたことを確かめてから次に進む。
- 実物の `claude` では起こせない状態は、PATH の前に偽の `claude` を置いて確かめる。`attach` だけ失敗させる(代替画面・マウス追跡・`stty raw` を残して exit 1)、`agents` だけ空配列・壊れた JSON・0 以外の終了を返す、など。ほかのサブコマンドは本物に `exec` で渡す。
- 実物のセッションに attach して文字を送ると、そのセッションの入力欄に残る(Enter を送らなければ送信はされない)。利用者のセッションに attach して確かめるときは、送った文字を消してから離脱する。
