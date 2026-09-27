## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`masahirompp/whatnext`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## サイクル型リライト開発(cycle-rewrite)

このプロジェクトはサイクル型リライト方式で開発する。サイクルの開始・終了・移行判断は cycle-rewrite スキルに従う。

### 層の定義

- 永続層: `docs/`(PRODUCT.md、DESIGN.md、adr/)、`README.md`、`LICENSE`、`CONTEXT.md`、`.claude/skills/`、CLAUDE.md、昇格済みモジュール: `lib/` — 厳格に維持する
- 使い捨て層: `src/` とテストコード — サイクル末に全削除する。品質は「動けばOK」
- ルートのビルド・パッケージ設定(`package.json`、`package-lock.json`、`tsconfig.json`、`.gitignore`)は削除対象外として残るが、次サイクルの足場であり自由に書き直してよい。ビルド出力 `dist/` は使い捨て層

パスは init で確定した値。cycle-end の削除対象はこの定義を正とする。コードは雑に、ドキュメントは厳格に。

### 要件と設計の2ファイル

`docs/PRODUCT.md` は要件(何を実現するか。観測できる振る舞い、受け入れシナリオ、Out of Scope)、`docs/DESIGN.md` は設計(どう実現するか。技術と依存、入力の出どころ、フック・OTel・会話記録の受け方、確かめ方)を書く(cycle 4 の cycle-end で分けた。#127)。境界は下の自律判断の層1と層2で引く。cycle-rewrite スキルは PRODUCT.md の単一ファイルを前提にしているので、スキルが PRODUCT.md を読む場面(cycle-start、cycle-audit、実装セッションのインプット)では、DESIGN.md も合わせて読む。2ファイルの間は見出しの名前で参照する。

**使い捨て層の削除は cycle-end の儀式の中でのみ行う**: issue 棚卸しの完了 → `git tag cycle-N` の作成 → 人間の明示的な承認、を必ずこの順で経ること。タグ前・承認前の削除は、学びと復元手段を同時に失う。

### 昇格済みモジュール

仕様が収束したモジュールは、cycle-end で人間の承認を経て `lib/` に昇格し、以後は永続層として厳格に維持する(テストを持ち越し、インターフェース契約を docs に置く)。依存方向は使い捨て層 → 昇格モジュールの一方向のみ。実装セッションは契約 docs 経由で使い、中身のコードは読まない。

### AI の自律判断(3層)

1. **内部設計の変更**(外から見える挙動が変わらない): 自律で進めてよい。ただし判断内容を `decision-log` ラベル付き issue に記録し、確認フェーズで一括報告する。
2. **観測可能な挙動・仕様の変更**: 人間へのエスカレーション必須。質問は「挙動 A と挙動 B のどちらが欲しいか」というドメイン語の二択で行う。コードの理解を要求する質問はしない。二択で表現できない変更は層1として扱う。
3. **不可逆・外部影響**(課金、外部 API 契約、データ破壊等): 常に同期エスカレーション。例外なし。

### 学びの捕捉

実装・確認中に得た学び(エッジケース、想定外挙動、暗黙の要件、ライブラリのハマり)は発見の都度 GitHub issue に起票する。ラベル(`bug` / `learning` / `spec-change` / `decision-log`)+ 現在サイクルのマイルストーンを付ける。issue は受信箱であり、次サイクルのインプットは蒸留済み docs のみ。

### ブランチ・マージ方針

- PR は使わない。短命ブランチ(worktree)で作業し、ローカルチェック(build/lint、テストがあればテスト)通過を条件にローカルで main にマージする
- 1つのセッションで順に進めるときは、main に直接コミットしてよい。短命ブランチ(worktree)は、並列に進めるときに使う。どちらでも、コミットの前にローカルチェック(build/lint、テストがあればテスト)を通し、「main は常に起動する」を守る
- 不変条件: main は常に起動する

### 見た目の決定

画面の見た目(列の並び、字下げ、入れ子、注記の出し方)に関わる決定は、文章の説明ではなく、等幅の画面の例を示して合意する。「採らない」と決めた案も、画面の例で「こうはならない」と見せる。文章だけで決めると、利用者と AI が違う絵を思い浮かべたまま合意しうる(cycle 3 では、`↳ for <名前>` の注記を利用者は入れ子と受け取っていて、実装を見るまで食い違いに気づかなかった)。実装のあとの調整でも、実際の画面(tmux の capture)を並べて比べる。

### ADR の基準

「覆すのが難しい判断のみ書く」は本プロジェクトでは「**サイクルを跨いでも覆らないか**」で解釈する。捨てる予定のコードに紐づく実装レベルの判断は ADR にしない(`decision-log` issue でよい)。

### 旧サイクルコードの参照

旧サイクルのコードを作業ツリーに置かない。参照が必要なら `git show cycle-N:src/...` か、作業ツリー外への `git worktree` を使う。
