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

## キーの割り当てと書式
- `bind` → `display-popup` → シェル、のように引用が入れ子になると、`#{session_name}` などの書式が展開されずに空になった。キーの処理は `run-shell -b "<スクリプト> '#{session_name}' '#{client_tty}' '#{@変数}'"` で小さなスクリプトに渡す。`run-shell` の引数は書式が展開される。
- popup の中で動かすクライアントは、同じサーバに入れ子で attach する。`env -u TMUX tmux -L <名前> new -A -s sh-<id> -c <cwd>` のように `TMUX` を外す。
- popup を開いている間のキーは、popup の中のクライアントが受ける(`#{session_name}` は `sh-<id>`)。横のペインに同じクライアントを置いた場合は、外側のクライアントが受ける(`#{session_name}` は `<id>`、どのペインかは `#{pane_id}`)。キーの処理は、どちらの受け手でも正しく分岐させる。
- popup の中から一覧まで戻るには、`detach-client -s <id>` で外側のクライアントを detach する。popup も一緒に閉じる。
- Claude Code は `ctrl+b`(`task:background`)、`ctrl+]`、`ctrl+g` などを使う。ルートのキー表に割り当てたキーは claude にもシェルにも届かなくなる。

## フックとペインの寿命
- ペインのフックは `show-hooks -gw` に出る(`pane-title-changed`、`pane-died`、`pane-exited` など)。`show-hooks -g` には出ない。
- ← で Agent View に入ったことは、`set-hook -g pane-title-changed "if -F '#{m:*claude agents*,#{pane_title}}' '<処理>'"` で拾えた。
- 分割の配置を残したまま claude のペインだけ畳むには、ウィンドウに `remain-on-exit on` を付ける。死んだペインは位置と幅を保ち、`respawn-pane -t <ペイン> "<コマンド>"` で同じ場所に作り直せる。

## 確かめるときの罠
- `pkill -f 'sleep 1001'` は、それを包む `sh -c 'sleep 1001; ...'` まで殺し、後ろのコマンドが走らない。`pkill -x -f` で完全一致にする。
- zsh はパイプの中の `while` を Ctrl+Z で停止できない(`job can't be suspended`)。ジョブ停止を確かめるときは `sleep` などの単純なコマンドを使う。
- unix socket のパスには長さの上限(macOS で 104 バイト)がある。scratchpad の深いパスでは socket を作れない。
- 外側の端末の代わりに別の tmux サーバ(`tmux -L <外側> new -d ...`)を立て、そこから send-keys でキーを送ると、利用者の tmux の中で入れ子に動かした場合も同時に確かめられる。
