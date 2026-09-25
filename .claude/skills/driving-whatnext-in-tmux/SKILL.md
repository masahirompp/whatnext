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
