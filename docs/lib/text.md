# 文字の幅と色（`lib/text/text.ts`）

端末に描く文字列の幅の計算と色。外部に触れない純粋な関数で、`string-width` と `cli-truncate` に頼る。罠は working-with-the-terminal スキルにある。

- `width(s)`：表示幅。全角は2桁、色などの制御列は0桁、曖昧幅の文字（`─ … ├ └ │ █ ·`）は1桁で数える（#259）。
- `truncate(s, w)`：幅 `w` に収め、切ったときは末尾を `…` にする（`…` の1桁も幅に含める）。書記素の途中では切らない。
- `padEnd(s, w)`、`padStart(s, w)`：幅 `w` に切ってから（`truncate`）、表示幅で `w` まで右（`padStart` は左）に空白を足す。
- `color`：`bold`、`dim`、`red`、`green`、`yellow`、`blue`、`magenta`、`cyan`、`gray`、`inverse`。文字列を SGR で囲む。空文字はそのまま返す。`NO_COLOR` も端末の種類も見ず、常に色を出す（PRODUCT.md「一覧の表示」、#262）。
  - 太字と薄字は解除の列（SGR 22）が同じなので、薄い範囲の中に太字を入れると、閉じたあとが薄くならない。
- `stripAnsi(s)`：色などの制御列を除く。`oneLine(s)`：改行とタブを空白にする（ほかの制御文字は除かない）。
