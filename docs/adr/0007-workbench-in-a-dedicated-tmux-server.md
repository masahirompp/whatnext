---
status: accepted
---

# 作業台は whatnext 専用の tmux サーバに置き、セッションの画面の上に popup で出す

利用者は仕事用の PC で Claude Code を sandbox の中で動かし、credential を読めないように設定している。
そのため docker、gcloud、terraform などは sandbox の中では動かせず（`!` で打っても同じ）、人が sandbox の外で手で動かす。
手で動かすときに「どのセッションのための端末か」「その端末がどこに行ったか」で迷う。これが Problem Statement の「ウィンドウが散らばる」の具体例である。

whatnext は、セッションごとに**作業台**（そのセッションの作業ディレクトリで開いたシェル）を持ち、セッションの画面から離れずに開けるようにする。そのために tmux を使う。

- whatnext は専用の tmux サーバ（`tmux -L <名前> -f <whatnext の設定>`）を使い、利用者の tmux サーバや設定には触れない。tmux は作業台のためだけに使うので、利用者から隠す。
- `Enter` で、whatnext の子として `tmux ... new -A -s <id> -c <cwd> "claude attach <id>; tmux detach-client"` を動かす。子が終わることが「attach から戻った」になり、端末を明け渡す仕組みは今のまま使える。
- 作業台は同じサーバの別セッション `sh-<id>` に置き、キーで popup として claude の画面の上に出し入れする。popup の中では分割やウィンドウの追加ができ、それは `sh-<id>` に残るので、popup を閉じても whatnext を閉じても、動かしているもの（e2e など）は続く。
- 一覧に戻る操作は、どこでも効く専用のキーと、← で Agent View に入ったこと（端末のタイトルが `claude agents` に変わる。`pane-title-changed` のフックで拾う）。claude のペインの Ctrl+Z は attach に組み込まれた離脱で、何もしなくても一覧に戻る。
- 戻るたびに `claude attach` は畳む（1本あたり約 140MB）。入り直すときのタイムラグは受け入れる。
- セッション本体は引き続き `claude --bg` で起動する。

## Considered Options

- **利用者の tmux サーバに `whatnext` セッションを置く**：一覧に戻るキーをサーバ全体に割り当てることになり、利用者の設定を書き換える。
- **一覧も tmux の中（window 0）で動かす**：whatnext 自体が tmux の中に入り、利用者の tmux の中で起動すると入れ子の扱いが増える。子として attach する形なら、今の仕組みがそのまま残る。
- **tmux を使わず、作業台は一覧の行から全画面で開く**（`/usr/bin/screen` や `dtach` でシェルを生かす）：セッションの画面から離れずに開けない（Ctrl+Z → 一覧 → 行のキーの2手）。← の誤操作も検知できない。会話を読みながらその場で作業台を開けることが、解きたい問題の核心なので採らない。
- **whatnext が端末と `claude attach` の間に入り、画面を合成する**：node-pty と端末エミュレータの自作になる（Out of Scope「一覧の常時表示」と同じ理由で、依存の総量が tmux より重い）。
- **端末のアプリの機能**（Ghostty の分割など）：外から操作する口がない。端末のアプリごとに作ることになる。
- **エディタの端末を作業台にする**：ウィンドウを行き来する問題そのもの。
- **作業台を横のペインに出す**：実装の違いは小さい（`split-window` か `display-popup` か）。popup なら claude の画面の大きさが変わらず、フォーカスを移すキーも要らない。popup の中でも分割できるので、popup だけにした。
- **`claude attach` を畳まずに常駐させる**：入り直しが速いが、入ったセッションの数だけメモリを使う。← のあとは Agent View を映したまま残るので、残しても作り直しが要る。
- **`--bg` をやめて、普通の `claude` を tmux の中で動かす**：← を押すと会話が別の `id` の `--bg` のセッションに移る。`--json` の `id` と `state` を失い、セッションの寿命を whatnext の tmux サーバが握ることになる（[ADR-0002](0002-no-writes-no-persistent-state.md)）。
- **一覧で選んだ行の画面をプレビューする**：読む負荷が attach と変わらない（Out of Scope）。

## Consequences

- tmux が必須の依存になる（[ADR-0008](0008-dependencies-and-contact-points-with-tmux.md)）。
- whatnext を閉じても、tmux サーバと作業台は残る。これは `claude --bg` でセッションを起こすのと同じ扱いで、状態を持つのは tmux であって whatnext ではない。whatnext は開き直したときに、tmux のセッション名（`sh-<id>`）から作業台を見つけ直す。そのため [ADR-0002](0002-no-writes-no-persistent-state.md) の「何も書き込まず、永続状態を持たない」は守られる。
- セッションを `rm` するときは、`sh-<id>` もまとめて閉じる。作業台でシェル以外のものが動いていれば、そのコマンド名を示して確認を求める（`terraform apply` の途中で閉じると state のロックが残るなど、取り返しがつかない）。
- Agent View から別のセッションに入る操作は、whatnext から入ったセッションでは使えなくなる。
- Claude Code が `ctrl+b` などを使うので、作業台のキーは claude の画面とシェルの両方で空いているものから選ぶ必要がある（cycle 4 で決める）。
