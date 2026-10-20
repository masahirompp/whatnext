---
status: accepted
---

# 対話セッションは、複製を開いて Claude Code 自身の画面で見せる

サイクル8の完了条件を満たしたあとに、利用者の依頼で決めた（2026-10-20）。

対話セッション（`--json` の `kind` が `interactive` の行）は `id` を持たず、`claude attach` も `claude logs` も使えない（`No job matching …`）。
それまで一覧の `Enter` は `cwd` と `pid` を示すだけで、何をしているかを確かめるには、そのセッションが動いている端末を探す必要があった。

そこで、一覧の `Enter` で、専用の tmux サーバの中に `claude --resume <sessionId> --fork-session` を開き、押した時点までの会話を Claude Code 自身の描き方で見せる。

- 複製は新しい ID のセッションなので、元のセッションの記録に2つのプロセスが書き込むことはない。
- 何も送らなければ、複製は会話記録を残さない（2.1.302 で、開いて閉じる前後で `~/.claude/projects/` のファイルが増えないことを確かめた）。
- 送ると、複製のエージェントが同じ場所で、利用者の既定の権限のモードのまま動き出す。それを防ぐため、見る画面のキーは tmux のキー表で絞り、スクロールと詳細の切り替え（`ctrl+o`）だけを渡す。ほかのキーは `Any` の割り当てで受けて捨てる。画面の解析や入力の注入はしないので、[ADR-0003](0003-no-input-injection-or-proxy-response.md) は守られる。
- 見せるのは押した時点までで、追いかけない。

## Considered Options

- **会話記録を読んで、自前で描く**：作業台の画面に流し続けることもでき、軽い。ただし Markdown、コードブロック、Edit の差分の描き方を自前で持つことになり、見た目は Claude Code の劣化コピーになる。形式が非公開なのは複製の案と同じで（[ADR-0011](0011-fill-in-from-transcripts-when-hooks-are-missing.md)）、作る量は数百行多い。見た目の再現度と作る量で、複製の案を採った。
- **既存の OSS（claude-esp、cc2md、cclog など）を組み込む**：どれも Go か Python の単体のプログラムで、`npx` で動く配布物に別の導入を求めることになる。`q` で一覧に戻るつなぎ目も外のプログラムに持てない。
- **`/export` で書き出して見せる**：外から `claude -p --resume <id> "/export …"` と呼ぶと `/export isn't available in this environment.` で断られる（2.1.302）。対話セッションの端末にキーを送り込むのは ADR-0003 に反し、その端末は tmux の外にある。
- **入力を tmux の `select-pane -d` で止める**：スクロールのキーも止まり、利用者が `CLAUDE_CODE_NO_FLICKER` で使う全画面の描き方（代替画面）では会話をさかのぼれない。
- **Ghostty の AppleScript で、`cwd` の同じ端末にフォーカスを移す**：端末の `working directory` は読めるが tty は読めず、同じ場所の端末が複数あると取り違える。

## Consequences

- 開くたびに `claude` が1つ起動し、表示まで数秒かかり、数百 MB のメモリを使う。そのため作業台の画面（カーソルの行に追従する）には使わない。見る画面は一度に1つで、`q` で畳む。
- 利用者の SessionStart のフックや MCP のサーバは、開くたびに動く。
- 「何も送らなければ記録を残さない」は実測で、仕様として書かれたものではない。`claude` の更新で変わったときは、会話記録の一覧に `--fork-session` の複製が残る。checking-claude-cli スキルで版を上げるときに確かめる。
- ターンの途中のセッションを開くと、複製ではそのターンが `Interrupted` と出る。元のセッションは止まらない。
