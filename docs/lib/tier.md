# 段の判定（`lib/tier/classify.ts`）

`claude agents --json` の1行から段を決める。規則の正は [PRODUCT.md](../PRODUCT.md)「段」と「`--json` の行から段を決める規則」で、この部品はそれをそのまま実装する。外部に触れない純粋な関数である。

- `AgentRow`：`--json` の1行（`lib/input` の `JsonRow` と同じ形）。
- `Tier`：`permission`、`question`、`sandbox`、`failed`、`review`、`working`、`waiting`、`stopped`。`TIERS` はこの順（放置コストを解除コストで割った値の大きい順）で、`TIER_LABEL` は STATUS の列の英語の表記。
- `classify(row)`：`{tier, reason?}` を返す。`tier` が `null` なら対象外（`interactive` の `idle`）。`reason` は STATUS に括弧で添える待機の理由で、段から分からないときだけ付く。どの規則にも当たらない行は質問待ちにし、規則に当たらなかった原因の値を添える（`pid` のある `blocked` なら `blocked`。#265）。
  - 待ちの段（`waiting`）はこの関数では返さない。待ち先と起動元の関係から導くのは使う側である。
- `dedupe(rows)`：同じ `sessionId` の行を1行にまとめる。`pid` を持つ行を採り、どちらも持たないとき、どちらも持つときは `background` の行を採る（#265）。順は最初に出た位置を保つ。
- `rowName(row)`：`name`、なければ `id`、それもなければ `sessionId` の先頭 8 文字。
- `statusLabel(tier, reason?)`：`Question (blocked)` のような STATUS の表記。

`--json` の行の形が変わったら、PRODUCT.md の表と規則を直してから、テスト（`classify.test.ts`）とこの部品を直す。
