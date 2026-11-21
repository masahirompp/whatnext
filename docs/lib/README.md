# `lib/` の部品の契約

`lib/` にある部品は、サイクル8の終わりに、仕様が収束した末端の部品として `src/` から分けた（[ADR-0021](../adr/0021-promote-leaf-modules-to-lib.md)）。サイクル型リライトを終えたあと（[ADR-0023](../adr/0023-end-cycle-rewrite-and-move-to-normal-development.md)）も、契約の docs とともに維持する。

- 使う側（`src/`）は、このディレクトリの契約に書いた振る舞いだけに頼る。
- 依存は `src/` → `lib/` の一方向だけである。`lib/` から `src/` を import しない。`lib/` の中では、`lib/tmux` が `lib/input/exec` の `Run` を使うだけである。
- テストは各部品の横（`lib/<部品>/*.test.ts`）に置き、`npm test` で流す。
- 振る舞いを変えるときは、先に PRODUCT.md・DESIGN.md とこの契約を直し、テストを足してからコードを直す。

| 部品 | 契約 | 中身 |
|---|---|---|
| 入力 | [input.md](input.md) | 外部コマンドの口、`claude agents --json`、Usage、フックと OTel の受け口、会話記録、補う値、プロセス表 |
| tmux | [tmux.md](tmux.md) | 専用の tmux サーバの設定と操作、claude の画面と作業台のセッション、Ghostty の分割とタブ |
| 段の判定 | [tier.md](tier.md) | `--json` の行から段を決める、重複を除く |
| 文字の幅と色 | [text.md](text.md) | 表示幅、切り詰め、揃え、色 |

ここに入れなかったもの（`src/` にある）: 起動元の導き方（`spawners`）、場所の問い合わせ（`git` と `gh`。#246 が未決）、attach している間のキーの表、段と並び、画面の組み立て、操作、状態のファイル、cli。
