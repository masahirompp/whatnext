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
- 全体の `detach-on-destroy` を `off` にすると、作業台の最後のシェルを抜けたとき、popup の中のクライアントが claude の画面のセッションに移り、popup が入れ子になった。`on` にし、クライアントが見ているセッションを畳む前に、クライアントを別のセッションに切り替えておく(先に畳むと、クライアントごと離れて端末がシェルに戻る)。
- 子として動かす `tmux attach` は、終わるときに主画面へ `[detached (from session <id>)]` か `[exited]` を1行書く。whatnext は代替画面で動くので見えないが、whatnext を終了すると主画面にこの行が並んで残る。子の終了後に `\x1b[1A\x1b[2K` でその行を消してから描き直すと残らない。

- `terminal-features`(外側の端末の機能)は、クライアントが attach した時点の値で決まる。あとで `set -as terminal-features` をしても、つながっているクライアントには効かない。サーバを作る `new-session ... ';' set -as terminal-features ...` と同じ呼び出しで入れる(一覧が `source-file` で流し込むより先にランチャーのクライアントが attach するため)。`hyperlinks` がないと、tmux はペインの中の OSC 8 を外側の端末に送らず、文字だけ出す。`RGB` は設定がなくても、`COLORTERM=truecolor` から付くことがある。
- ユーザーオプション(`set -g @x "<本文>"`)には、複数行・タブ・引用符・`#{…}`・バックスラッシュを含む本文を置けて、`show -gv @x` がそのまま返す。キーから `sh -c "$(tmux -L <名前> show -gv @x)" …` で呼べ、ステータス行の `#(…)` の中の `$(…)` でも動く。スクリプトをファイルに置かずに、動いている一覧の版の本文だけを使わせられる。
- 本文を `set-environment -g` に置く形は採らない。作業台のシェルの環境に本文が見える。作業台のセッションだけ `-e VAR=` で空にすると、そのセッションで押したキーの run-shell からも見えなくなり、作業台の中のキーが効かなかった。

## キーの割り当てと書式
- `bind` → `display-popup` → シェル、のように引用が入れ子になると、`#{session_name}` などの書式が展開されずに空になった。キーの処理は `run-shell -b "<スクリプト> '#{session_name}' '#{client_tty}' '#{@変数}'"` で小さなスクリプトに渡す。`run-shell` の引数は書式が展開される。
- popup の中で動かすクライアントは、同じサーバに入れ子で attach する。`env -u TMUX tmux -L <名前> new -A -s sh-<id> -c <cwd>` のように `TMUX` を外す。
- popup を開いている間のキーは、popup の中のクライアントが受ける(`#{session_name}` は `sh-<id>`)。横のペインに同じクライアントを置いた場合は、外側のクライアントが受ける(`#{session_name}` は `<id>`、どのペインかは `#{pane_id}`)。キーの処理は、どちらの受け手でも正しく分岐させる。
- popup の中から一覧まで戻るには、`detach-client -s <id>` で外側のクライアントを detach する。popup も一緒に閉じる。
- Claude Code は `ctrl+b`(`task:background`)、`ctrl+]`、`ctrl+g` などを使う。ルートのキー表に割り当てたキーは claude にもシェルにも届かなくなる。
- `set`(`set-option`)の `-t` は target-pane なので、セッションを名前で指すときは末尾にコロンを付けて `-t =<名前>:` とする。`-t =<名前>` は、セッションがあっても `no such session: =<名前>` で失敗する(終了コード 1)。同じコマンド列の中で作った直後でも、コロンを付ければ通る。`has-session` と `kill-session` の `-t` は target-session なので、コロンなしで通る。
- 失敗しても、`source-file` の中や `execFile` の戻りを見ていなければ気づかない。サイクル5では、claude の画面のセッションに `prefix None` と `@wn_claude` が入らず、← の検知が発火しなかった(`ctrl+q l` は、全体の prefix が claude の画面でも効いたせいで偶然動いていた)。サイクル4では、作業台の popup が `@wn_cwd` を読めず `~` で開いた。
- キーに割り当てた `run-shell -b "<コマンド>"` が 0 以外で終わるか何かを出力すると、tmux はその結果を、その時点のアクティブなペインに view mode(`[0/0]`)で被せて出す(popup の中から `ctrl+q l` で外側のクライアントを detach すると `display-popup` が 0 以外で終わり、作業台のペインに残った)。キーのコマンドの末尾を `>/dev/null 2>&1; true` にして抑える。

- `bind` は追記なので、設定を入れ直しても前の割り当ては消えない。割り当てをやめるときは `unbind -q` するか、既定の割り当てを明示して上書きする(`bind l last-window`)。`set -as`(追記)も入れ直すたびに積み重なる。サーバが残ったまま一覧が起動し直すと、前の版の割り当てが残りうる。
- prefix の既定の割り当てがない小文字は `a b e g h j k u v y` だけ。`n`(next-window)、`x`(kill-pane)、`l`(last-window)、`w`、`r`、`q` はふさがっている。ctrl を押したままの形(`C-l` など)は、`C-o`・`C-z` などを除いてほぼ空いている。
- `display-popup -B -w 100% -h 50% -x 0 -y 0` で、枠なしの popup が画面の上半分に出る。枠がないとタイトル(`-T`)も出ない。

## メニューと貼り付け
- `tmux display-menu -c <client> …` をコマンド行から呼ぶと、メニューが閉じるまで戻らない。whatnext から呼ぶときは終わりを待たない(`spawn` して `unref`)。`execFile` のタイムアウトで待つと、メニューを開いたまま考えている間に殺される。
- `status off` のサーバでも、`display-message -c <client> -d 2000 '<文言>'` はクライアントの最下行に重ねて出る(claude の画面では入力欄の下の行、popup では popup の最下行)。文言は書式として解釈されるので `#` を `##` にする。
- ただし claude の画面では、`display-message` は `-d` の値にかかわらず約0.2秒で消えた(100ms おきに取ると12回中1〜3回しか見えない。作業台と一覧では2秒見えた)。status の行がないとき、メッセージはペインの最下行に重ねて描かれ、claude の再描画に上書きされると見ている(未確認)。150ms おきに `display-message -d 300` を出し直すと、2秒の間ほぼ見え続けた(20回中17回)。キーは claude に届いたまま。サイクル5の後半で claude の画面にステータス行を出したので、今も起きるかは確かめていない。
- `display-menu` の項目の名前が `-` で始まると、選べない行として薄く出る(`-` は表示されない)。キーとコマンドは空文字でよい(`display-menu … '- No pull request for this session.' '' ''`)。キーに `1`〜`9` を渡すと、項目の右に `(1)` と出る。項目の名前の `#` は書式として解釈されるので `##` にする。
- popup の中のクライアント(作業台)で押したキーでは、`#{session_name}` が `sh-<id>`、`#{client_tty}` が popup の中の端末になる。`display-menu -c` にその tty を渡すと、popup の中にメニューが出る。
- メニューの項目のコマンドから `run-shell -b "curl … --data-binary '<token> <番号>' …"` で whatnext の受け口に戻せば、選んだ文字列(コマンドなど)を tmux やシェルの引用に通さずに済む。
- 貼り付けは `set-buffer -b <名前> -- <文字列>` のあと `paste-buffer -p -d -b <名前> -t <pane_id>`。`-p` で bracketed paste になり、zsh の入力欄に入って実行されなかった。

## ステータス行
- `status 2` にすると、`status-format[0]` が上の行、`[1]` が下の行になる(`status-position bottom` のとき)。`[1]` の既定はウィンドウの一覧なので、左右を出すなら `#[align=left]#{T;=/#{status-left-length}:status-left}#[align=right]...` を自分で書く。
- `#{@opt}` で出したオプションの値の中の `#[fg=red]` は色として効き、`##` は `#` になる。利用者由来の文字列(セッション名、依頼)は `#` を `##` にしてから置く。
- `status-right` は `status-right-length` の上限で切れる(端末の幅より先に切れて、幅で切れているように見えた)。
- 右寄せを `#{=/#{client_width}/…:status-right}` で切ると、先頭の1文字が欠けた。`#{e|-:#{client_width},1}` にすると欠けない。`#{=/N/…:var}` の N には入れ子の書式が使え、表示幅(全角は2桁)で切れる。

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
