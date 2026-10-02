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
- 1回の send-keys で複数のキーを送ると同じ塊で届き、人の手では起きない順序の問題が出うる(サイクル5の Ink では、前のキーの変更を次のキーが読めなかった)。人の操作を再現するときは1キーずつ送る。
- zsh では `T="tmux send-keys -t wn"; $T Up` が単語分割されず、`command not found` になる。キーを送る処理はシェル関数にする(例: `k() { for x in "$@"; do tmux send-keys -t wn "$x"; sleep 0.25; done; }`)。
- 保留の理由などの入力欄が開いていると、↑↓ は入力欄に吸われ、そのあとの Enter が別の行の操作を確定させる(実際に別のセッションを保留にした)。カーソルを名前で合わせる関数(上に戻してから下へ送り、`capture-pane` で `^> .*<名前>` を探す)を使うときも、操作のあとは入力欄が閉じたことを確かめてから次に進む。
- 利用者の whatnext が動いている横で確かめるときは、受け口のポートと専用の tmux サーバのソケット名を環境変数で変えられるようにしておく。どちらも固定の既定値なので、同じ値では2つ目として終了するか、利用者の作業台に触れてしまう。利用者向けのオプションではないので `--help` には載せない(cycle 4 の名前は `WHATNEXT_PORT` と `WHATNEXT_TMUX_SOCKET`)。
- 実物の `claude` では起こせない状態は、PATH の前に偽の `claude` を置いて確かめる。`attach` だけ失敗させる(代替画面・マウス追跡・`stty raw` を残して exit 1)、`agents` だけ空配列・壊れた JSON・0 以外の終了を返す、など。ほかのサブコマンドは本物に `exec` で渡す。
- 実物のセッションに attach して文字を送ると、そのセッションの入力欄に残る(Enter を送らなければ送信はされない)。利用者のセッションに attach して確かめるときは、送った文字を消してから離脱する。
- whatnext の中で動いているセッション(作業台を含む)のシェルには、`WHATNEXT_ROLE=list` と、利用者の既定値のままの `WHATNEXT_TMUX_SOCKET` と `WHATNEXT_PORT` が引き継がれている。一覧の役の判定はペインの場所も見るので、一覧としては動かない。ただし、ソケットとポートが利用者の値のままなので、引数なしで起動すると利用者のサーバにつなぎに行き、ほかのクライアントを離す(サイクル6では、変数だけで一覧として動き、利用者の attach を畳んだ)。確かめるときは3つとも付け替える(外側の tmux のセッションなら、ペインのコマンドの中で `env WHATNEXT_ROLE= ...` として渡す)。
- 終わったつもりで動き続けている一覧に `send-keys -l` で文字列を送ると、その文字がキーとして効く(`n` や `Enter` で起動や attach が走る)。送る前に capture で画面を確かめる。
- 確かめ用の tmux で `new-session -e PATH=<偽の bin>:$PATH` と渡しても、ペインのコマンドを実行するシェル(zsh)の起動処理で PATH が組み直され、偽の `claude` が使われなかった(`CLAUDE_CONFIG_DIR` は届いた)。環境はペインのコマンドの中で渡す: `tmux -L wnv new-session -d -s wn -x 130 -y 30 "env WHATNEXT_ROLE= WHATNEXT_TMUX_SOCKET=wn-verify WHATNEXT_PORT=14399 CLAUDE_CONFIG_DIR=$T/cfg PATH=$T/bin:\$PATH node dist/cli.js"`。
- 偽のセッションを作る: 偽の `claude` は `agents` なら固定の行(`[{"kind":"background","sessionId":"<uuid>","id":"bangtest","cwd":"/tmp","name":"bang-test","state":"done","status":"idle","pid":99999}]`)を返し、それ以外は `CLAUDE_CONFIG_DIR` を外して本物に `exec` する。会話記録は `$CLAUDE_CONFIG_DIR/projects/<任意>/<uuid>.jsonl` に、user の指示の行と assistant の text の行を置く。
- **偽の `claude` に実行の権限がないと、黙って本物が使われる。** Node の `execFile('claude')` は PATH の中の実行できないファイルを飛ばす。一覧に利用者の本物のセッションが並び、attach して文字を送ると利用者のセッションに入力される。偽の `claude` を置いたら、そのパスで直接 `claude agents --json` を実行して出力を確かめ、起動したら一覧の行が偽のセッションだけかを確かめてから操作する。
- **作業台に文字を送る前に、送り先が作業台の画面で、作業台ができているかを確かめる。** 送り先を取り違えると、文字は claude の画面の入力欄に入り、`Enter` で指示として送られる。`list-clients -F '#{client_tty} #{session_name}'` で、送り先の端末のクライアントが `sh-<id>` を映していることを確かめ、なければ止める(サイクル6までは popup の中のクライアントで確かめていた)。実物のセッションで試すときは `Enter` を送る操作を最小にする。
- 外側の tmux の中では、外側の tmux が端末の問い合わせに答えるので、端末の機能の差が出ない。端末の機能(`terminal-features` など)を確かめるときは、問い合わせに答えない pty(Python の `pty.fork`)からランチャーを動かし、端末に届いたバイト列(OSC 8 なら `ESC ]8;`)を見る。
