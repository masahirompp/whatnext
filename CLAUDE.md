## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`masahirompp/whatnext`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## 開発の進め方

### コードと docs の置き場所

- `src/`: 一覧の本体。`test/`: 単体(`test/unit/`)、画面の通し(`test/e2e/`)、実機の通し(`test/real/`)
- `lib/`: 末端の部品(入力、tmux、段の判定、文字の幅と色)。契約を `docs/lib/` に置き、依存は `src/` → `lib/` の一方向だけ。振る舞いを変えるときは、先に契約の docs を直す
- `mod/`: `n` で起動するセッションに付けるダイジェストの mod(`--no-digest` のときは付けない)(テストは `mod/tests/`)。npm の配布物に入り、Claude Code の中で動く(`docs/adr/0022-ship-a-digest-mod-for-launched-sessions.md`)
- `docs/PRODUCT.md` は要件(観測できる振る舞い、受け入れシナリオ、Out of Scope)、`docs/DESIGN.md` は設計(仕組み、確かめ方)。2ファイルの間は見出しの名前で参照する。挙動を変えるときは、同じ PR で docs も直す

### ブランチ・マージ

- main への変更はすべて PR を通す。CI(build、`npm run check`、`npm test`)が通らないとマージできない
- PR を出す前に、build、`npm run check`、`npm test` を通す。CI は `test:e2e` を下限の tmux(3.5a)で流す。最新の tmux での `test:e2e` と、`test:mod`、`test:real` は CI で流さないので、触れた範囲に応じて手元で流す(DESIGN.md「確かめ方」)

### 見た目の決定

画面の見た目(列の並び、字下げ、入れ子、注記の出し方)は、実際の描画(描画の関数か、画面の通しのテストで取った画面)の例を並べて利用者と合意する。採らない案も、取った画面を書き換えて「こうはならない」と見せる。文章や手で書いた例だと、利用者と AI が違う絵を思い浮かべたまま合意しうる。

### 機能の相談

利用者から機能の相談を受けたら、方式を比べる前に、きっかけになった場面と目的(どのセッションを、どういうときに、何を知るために)を一問確かめる。
