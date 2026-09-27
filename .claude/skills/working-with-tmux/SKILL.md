---
name: working-with-tmux
description: whatnext の作業台(専用の tmux サーバ、popup、キーの割り当て、フック)を実装するときに読む。tmux 3.7c で実測した使い方と罠。画面を操作して確かめる手順は driving-whatnext-in-tmux スキル。
---
# tmux で作業台を作るときの罠(tmux 3.7c で実測)

## 専用のサーバ
- `tmux -L <名前> -f <whatnext の設定>` で、利用者のサーバと設定から切り離す。設定では `set -g prefix None` にし、作業台のセッションにだけ `set -t sh-<id> prefix <キー>` で prefix を効かせる。claude の画面では prefix が効かず、キーは claude に届く。
- `new -A -s <id> -c <cwd> "<コマンド>" \; set ...` のように続けるときは、シェルのコマンドを `\;` より前に置く。後ろに置くと別のコマンドの引数になり、サーバに届かない。
- ペインの中で tmux を呼ぶときも `-L <名前>` を明示する(`claude attach <id>; tmux -L <名前> detach-client`)。
- ペインが1つだけのセッションでは、コマンドが終わるとセッションが閉じ、クライアントも `[exited]` で終わる。どちらでも whatnext から見れば子の終了になる。
- 子として動かす `tmux attach` は、終わるときに主画面へ `[detached (from session <id>)]` か `[exited]` を1行書く。whatnext は代替画面で動くので見えないが、whatnext を終了すると主画面にこの行が並んで残る。子の終了後に `\x1b[1A\x1b[2K` でその行を消してから描き直すと残らない。

## キーの割り当てと書式
- `bind` → `display-popup` → シェル、のように引用が入れ子になると、`#{session_name}` などの書式が展開されずに空になった。キーの処理は `run-shell -b "<スクリプト> '#{session_name}' '#{client_tty}' '#{@変数}'"` で小さなスクリプトに渡す。`run-shell` の引数は書式が展開される。
- popup の中で動かすクライアントは、同じサーバに入れ子で attach する。`env -u TMUX tmux -L <名前> new -A -s sh-<id> -c <cwd>` のように `TMUX` を外す。
- popup を開いている間のキーは、popup の中のクライアントが受ける(`#{session_name}` は `sh-<id>`)。横のペインに同じクライアントを置いた場合は、外側のクライアントが受ける(`#{session_name}` は `<id>`、どのペインかは `#{pane_id}`)。キーの処理は、どちらの受け手でも正しく分岐させる。
- popup の中から一覧まで戻るには、`detach-client -s <id>` で外側のクライアントを detach する。popup も一緒に閉じる。
- Claude Code は `ctrl+b`(`task:background`)、`ctrl+]`、`ctrl+g` などを使う。ルートのキー表に割り当てたキーは claude にもシェルにも届かなくなる。
- `new-session -d -s <id> ... \; set -t =<id> @opt v` のように、同じコマンド列の中で作ったばかりのセッションを `-t =<id>` で指すと `no such session: =<id>` で失敗し、オプションが入らない(作業台の popup が `@wn_cwd` を読めず `~` で開いた)。`-t` を付けない `set @opt v` なら、作ったばかりのセッションが現在のセッションなので入る。
- キーに割り当てた `run-shell -b "<コマンド>"` が 0 以外で終わるか何かを出力すると、tmux はその結果を、その時点のアクティブなペインに view mode(`[0/0]`)で被せて出す(popup の中から `ctrl+q l` で外側のクライアントを detach すると `display-popup` が 0 以外で終わり、作業台のペインに残った)。キーのコマンドの末尾を `>/dev/null 2>&1; true` にして抑える。

## メニューと貼り付け
- `tmux display-menu -c <client> …` をコマンド行から呼ぶと、メニューが閉じるまで戻らない。whatnext から呼ぶときは終わりを待たない(`spawn` して `unref`)。`execFile` のタイムアウトで待つと、メニューを開いたまま考えている間に殺される。
- `status off` のサーバでも、`display-message -c <client> -d 2000 '<文言>'` はクライアントの最下行に重ねて出る(claude の画面では入力欄の下の行、popup では popup の最下行)。文言は書式として解釈されるので `#` を `##` にする。
- popup の中のクライアント(作業台)で押したキーでは、`#{session_name}` が `sh-<id>`、`#{client_tty}` が popup の中の端末になる。`display-menu -c` にその tty を渡すと、popup の中にメニューが出る。
- メニューの項目のコマンドから `run-shell -b "curl … --data-binary '<token> <番号>' …"` で whatnext の受け口に戻せば、選んだ文字列(コマンドなど)を tmux やシェルの引用に通さずに済む。
- 貼り付けは `set-buffer -b <名前> -- <文字列>` のあと `paste-buffer -p -d -b <名前> -t <pane_id>`。`-p` で bracketed paste になり、zsh の入力欄に入って実行されなかった。

## フックとペインの寿命
- ペインのフックは `show-hooks -gw` に出る(`pane-title-changed`、`pane-died`、`pane-exited` など)。`show-hooks -g` には出ない。
- ← で Agent View に入ったことは、`set-hook -g pane-title-changed "if -F '#{m:*claude agents*,#{pane_title}}' '<処理>'"` で拾えた。
- `pane-title-changed` の条件に `session_name` との複合条件(`#{&&:#{m:*claude agents*,#{pane_title}},#{!=:#{m:sh-*,#{session_name}},1}}`)を書くと、タイトルが変わっても発火しなかった。claude のセッションにユーザオプション `@wn_claude 1` を付け、`#{&&:#{@wn_claude},#{m:*claude agents*,#{pane_title}}}` で絞ると効いた。フックの中の `kill-session` は `-t` なしで、フックが起きたセッションを閉じる。
- 分割の配置を残したまま claude のペインだけ畳むには、ウィンドウに `remain-on-exit on` を付ける。死んだペインは位置と幅を保ち、`respawn-pane -t <ペイン> "<コマンド>"` で同じ場所に作り直せる。

## 確かめるときの罠
- `pkill -f 'sleep 1001'` は、それを包む `sh -c 'sleep 1001; ...'` まで殺し、後ろのコマンドが走らない。`pkill -x -f` で完全一致にする。
- zsh はパイプの中の `while` を Ctrl+Z で停止できない(`job can't be suspended`)。ジョブ停止を確かめるときは `sleep` などの単純なコマンドを使う。
- unix socket のパスには長さの上限(macOS で 104 バイト)がある。scratchpad の深いパスでは socket を作れない。
- 外側の端末の代わりに別の tmux サーバ(`tmux -L <外側> new -d ...`)を立て、そこから send-keys でキーを送ると、利用者の tmux の中で入れ子に動かした場合も同時に確かめられる。
