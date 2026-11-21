## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`masahirompp/whatnext`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## 開発の進め方

`src/`、`lib/`、`mod/` とテストは、どれも本番品質のコードとして直しながら育てる。docs やスキルに出てくる「サイクル N」「cycle-end」「サイクルの完了条件」は、cycle 9(2026-11-21)まで使ったサイクル型リライト方式の経緯の記録で、今の手順ではない(`docs/adr/0023-end-cycle-rewrite-and-move-to-normal-development.md`)。

### コードと docs の置き場所

- `src/`: 一覧の本体。`test/`: 単体(`test/unit/`)、画面の通し(`test/e2e/`)、実機の通し(`test/real/`)
- `lib/`: 末端の部品(入力、tmux、段の判定、文字の幅と色)。契約を `docs/lib/` に置く。依存は `src/` → `lib/` の一方向だけ。振る舞いを変えるときは、先に契約の docs を直し、テストを足してからコードを直す
- `mod/`: `--digest` のときにセッションに付けるダイジェストの mod(テストは `mod/tests/`)。npm の配布物に入り、Claude Code の中で動く(`docs/adr/0022-ship-a-digest-mod-for-launched-sessions.md`)
- `docs/`(PRODUCT.md、DESIGN.md、adr/、lib/)、`README.md`、`CONTEXT.md`、`.claude/skills/`: コードと食い違わないように保つ(下の「挙動を変えるとき」)

### 要件と設計の2ファイル

`docs/PRODUCT.md` は要件(何を実現するか。観測できる振る舞い、受け入れシナリオ、Out of Scope)、`docs/DESIGN.md` は設計(どう実現するか。技術と依存、入力の出どころ、フック・OTel・会話記録の受け方、確かめ方)を書く。境界は下の自律判断の層1と層2で引く。2ファイルの間は見出しの名前で参照する。

### 挙動を変えるとき

利用者から見える挙動を変える PR では、コードと一緒に次を直す。docs とコードの食い違いを書き直しで洗い出す機会はもうないので、この2つが食い違いを防ぐ手段になる(ADR-0023)。

- `docs/PRODUCT.md` の該当の節と受け入れシナリオ。仕組みが変わるなら `docs/DESIGN.md` も
- そのシナリオを確かめるテスト(単体か画面の通し)。足すか、書き換える

### AI の自律判断(3層)

1. **内部設計の変更**(外から見える挙動が変わらない): 自律で進めてよい。ただし判断内容を `decision-log` ラベル付き issue に記録し、その PR の本文に issue を並べて報告する。
2. **観測可能な挙動・仕様の変更**: 人間へのエスカレーション必須。質問は「挙動 A と挙動 B のどちらが欲しいか」というドメイン語の二択で行う。コードの理解を要求する質問はしない。二択で表現できない変更は層1として扱う。
3. **不可逆・外部影響**(課金、外部 API 契約、データ破壊等): 常に同期エスカレーション。例外なし。

### 学びの捕捉

実装・確認中に得た学び(エッジケース、想定外挙動、暗黙の要件、ライブラリのハマり)は発見の都度 GitHub issue に起票する。ラベル(`bug` / `learning` / `spec-change` / `decision-log`)を付ける。issue は受信箱であり、長く効く学びは docs かスキルに書いてから閉じる。版を上げる前(releasing-whatnext スキル)に、open の `learning`・`decision-log`・`spec-change` を棚卸しし、docs かスキルに書くか閉じる。

### ブランチ・マージ方針

- main への変更は、すべて PR を通す。main は GitHub のルールで守っていて、CI(`.github/workflows/ci.yml` の `check (22)` と `check (24)`。build、`npm run check`、`npm test`)が通らないとマージできず、main への直接の push もできない(管理者も例外にしない)
- ブランチで作業し、PR を出す前にローカルチェック(build、`npm run check`(biome の書式と lint)、`npm test`)を通す。CI は `test:e2e`、`test:mod`、`test:real` を流さないので、触れた範囲に応じて手元で流す(DESIGN.md「確かめ方」)。並列に進めるときは worktree を使う。review-loop でセルフレビューを回すときも、同じ PR を使う
- 不変条件: main は常に起動する

### 見た目の決定

画面の見た目(列の並び、字下げ、入れ子、注記の出し方)に関わる決定は、文章の説明ではなく、等幅の画面の例を示して合意する。「採らない」と決めた案も、画面の例で「こうはならない」と見せる。文章だけで決めると、利用者と AI が違う絵を思い浮かべたまま合意しうる(cycle 3 では、`↳ for <名前>` の注記を利用者は入れ子と受け取っていて、実装を見るまで食い違いに気づかなかった)。実装のあとの調整でも、実際の画面(tmux の capture)を並べて比べる。

画面の例は手で書かず、実際の描画(描画の関数か、画面の通しのテストで取った画面)から作る。手で書いた例は字下げがずれ、利用者がそれを見て選ぶと、字下げの水準で違う絵のまま合意しうる(cycle 8 の `(sub)` の決定で、入れ子の線と一言の行をカーソルの列の分だけ字下げし忘れた)。「こうはならない」の例は、取った画面を書き換えて作り、幅は計算して揃える。

### 機能の相談

利用者から機能の相談を受けたら、方式を比べる前に、きっかけになった具体的な場面と目的(どのセッションを、どういうときに、何を知るために)を一問確かめる。cycle 8 では、対話セッションを覗く機能を方式の比較から実装まで進めたあと、利用者が本当に確かめたかったのは「`claude -p` で起動したセッションが一覧に出るか」だったと分かり、取り下げた。費用の大きい方式は、使う頻度と目的で作りが変わる。安全が実測の挙動に頼る方式は、補強の手段を最初の提案に含める。

### ADR の基準

覆すのが難しい判断だけを ADR に書く。実装の水準の判断は ADR にせず、`decision-log` の issue に残す。
