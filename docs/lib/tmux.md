# tmux（`lib/tmux/`）

専用の tmux サーバの設定と操作。仕組みは [DESIGN.md](../DESIGN.md)「一覧と作業台の仕組み」「作業台の画面の仕組み」、罠は working-with-tmux スキルにある。この部品は「何をするか」の仕組みだけを持ち、いつ呼ぶか（一覧と作業台の制御）は使う側が持つ。

## 名前の約束

- サーバは `tmux -L <ソケット名>`。一覧のセッションは `LIST`（`list`）、作業台の案内のセッションは `GUIDE`（`wbguide`）。
- claude の画面のセッションは `<id>`（中で `claude attach <id>`）、作業台は `sh-<id>`、信頼の確認は `trust-<乱数>`。
- 一覧のプロセスの pid は `@wn_pid`、版は `@wn_version`、claude の画面のステータス行のキーの説明は `@wn_keys`、概要の行は `@wn_summary`（セッションのオプション）に置く。
- キーとフックは、頼みごとを `@wn_req_<秒>_<pid>` に書いてから一覧に SIGUSR2 を送る。頼みごとの形は `key <action> <セッション名> <client_tty>`、`focus <client_tty>`、`agentview <セッション名>`。作業台の最後のシェルが終わったときは `@wn_closed` に `<id>` を書く。

## 設定（`serverConfig`、`scripts`）

- `serverConfig({socket, listPid, version, env, keys, keysHelp})`：一覧が `source-file -` で流し込む設定の文字列。次を含む。
  - サーバ全体：prefix なし、`escape-time 10`、`extended-keys on`（csi-u）、`focus-events on`、`set-clipboard on`、`allow-passthrough on`（#268）、`history-limit 20000`、`detach-on-destroy on`、`remain-on-exit on`、ステータス行なし、マウスなし、`default-terminal tmux-256color`。
  - `env` の環境変数（`set-environment -g`）。
  - `ctrl+q` のあとのキー：`keys`（`AttachKeyBinding` の列。`letter`、`action`、`bare`）ごとに `ctrl+q ctrl+<letter>` を割り当て、`bare` なら `ctrl+q <letter>` も同じにする。どのキーを置くかは使う側が決める。
  - 一覧に知らせるフック（`client-session-changed`、`client-attached`、`client-detached`、`session-closed`、`client-focus-in`、← の `pane-title-changed`）と、作業台の最後のシェルの `pane-died`。
  - 一覧のセッションでは `ctrl+q` を効かせない（`key-table wnlist`）。
- `scripts(socket)`：キーとフックが呼ぶ sh の本文（頼みごと、`pane-died` の後始末、claude の画面の作業台の欄）。`Tmux.sourceConfig` が設定と一緒に置く。
- `terminal-features`（色の `RGB`、リンクの `hyperlinks`）は、サーバを作る `new-session` で入れる必要があり（DESIGN.md「一覧と作業台の仕組み」）、この設定には含まない。

## 操作（`Tmux`）

`new Tmux(socket, run)`。どの操作も、失敗を例外にせず、真偽値か空の値で返す。

- 生のコマンド：`t(args, input?)`（専用サーバに tmux のコマンドをそのまま送り、`RunResult` を返す。下の操作にない設定やセッションの作成に使う。サイクル9で契約に書き足した。#275）。
- 問い合わせ：`hasSession`、`sessions`、`clients`（`tty`、`session`、`termname`、`pid`）、`option`。
- 設定：`setOption`、`unsetOption`、`sourceConfig(text)`（新しいサーバに初めて流し込むと、`table wnq doesn't exist` で 0 以外を返すが、キー、フック、オプションは入る。サイクル9で確かめた。#275）、`takeRequests()`（頼みごとを書かれた順に取り出して消す）。
- クライアント：`switchClient(tty, target)`、`detachClient(tty)`、`display(tty, text, ms?)`（短い知らせ。`#` は書式にならないよう直す）。
- セッション：`ensureClaudeSession(id, cwd, size)`（claude の画面。ステータス行2行。`claude attach` が 0 以外で終わったら、キーを待ってから一覧に戻す）、`setSummary(id, text)`、`createWorkbench(id, cwd, name)`（`sh-<id>`。prefix `ctrl+q`、マウス on、タイトル `whatnext workbench`、ステータス行1行。作業台では窓の一覧のあとに分割とウィンドウのキーを続ける）、`workbenchOptions(session, name)`、`setSessionName(session, name)`、`newTrustSession(dir)`、`killSession`、`killServer`、`signalGuide()`（案内のセッションのプログラムに読み直しを促す。送るシグナルは契約にないので、案内のプログラムは知らせだけに頼らず、自分でも読み直す。#275）。
- `running()`：作業台ごとに、シェル以外で動いているもののコマンド行（パイプは ` | ` でつなぐ）。戻りは `Map<string, string[]>` で、キーは作業台のセッションの `<id>`（`sh-` を付けない）である（サイクル9で使って確かめた。#275）。`parsePs(text)` と `foregroundCommand(procs, shellPid)` はその判定。作業台のペインの直接の子だけを見る。

## 文字列の補助

- `escapeFormat(s)`：tmux の書式に置く文字列の `#` を `##` にする。`shq(s)`：シェルの単一引用符で囲む。

## Ghostty（`ghostty.ts`）

- `focusWorkbench(run)`：名前が `whatnext workbench` の Ghostty の分割へフォーカスを移す。
- `splitWorkbench(run, command, env)`：前面の Ghostty の、フォーカスのある分割を右に分割し、`command` を打ち込む（[ADR-0015](../adr/0015-ghostty-split-for-workbench-on-ctrl-q-ctrl-w.md)）。
- 結果は `focused`、`split`、`none`（作業台の画面がない）、`notfront`（Ghostty が前面にない）、`failed`。Ghostty の端末で押したときだけ呼ぶかは、使う側が `client_termname` で決める。

## テスト

単体のテスト（`lib/tmux/tmux.test.ts`）は、設定の中身とプロセス表の判定だけを確かめる。tmux を実際に動かす確かめは、使う側の画面の通し（サイクル9の `test/e2e/`）が担う。
