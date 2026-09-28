---
name: working-with-the-terminal
description: whatnext の一覧の画面の描画(同期出力、幅の計算、色)とキー入力(readline の keypress、Esc、貼り付け)を、Ink を使わずに実装するときに読む。Node 24 と tmux 3.7c で実測した使い方と罠。
---
# 一覧を自前で描き、キーを受けるときの罠

一覧は Ink を使わない(DESIGN.md「描画とキー入力」)。サイクル6の開始時の試作(`proto/cycle-6-no-ink` ブランチの `prototype/no-ink.mjs`)で、専用サーバと同じ設定(`escape-time 10`、`extended-keys on`、`extended-keys-format csi-u`)の tmux 3.7c と Node 24.16.0 を使って確かめた。

## キー入力(readline)

- `readline.emitKeypressEvents(stdin, {escapeCodeTimeout: 30})` のあとに `stdin.setRawMode(true)` と `stdin.on('keypress', (str, key) => …)`。Esc 単独は、生の `1b` が届いてから約 31ms で `key.name === 'escape'` になる(既定の 500ms では遅すぎる)。
- **Esc 単独のキーは `key.meta === true` で届く。** 「`meta` なら Option+キー」と判定すると Esc を取り違える。Esc は `key.name === 'escape'` で先に見る。
- `Ctrl+X` は `key.ctrl && key.name === 'x'`(生は `\x18`)。専用サーバが `extended-keys on` でも、アプリが求めない限り tmux は CSI-u を送らない。CSI-u を求める制御列(`\e[>1u` など)を一覧から書かない。
- 貼り付け:`\e[?2004h` で bracketed paste を有効にすると、`key.name` が `paste-start` と `paste-end` の keypress に挟まれて、中身が1文字ずつ keypress で届く。間の文字をためて1回の入力にする。ためている間は、中身の文字をキーとして解釈しない(`h` や `q` が操作として効いてしまう)。改行は `\r` で届くので、1行の入力欄では `\r` と `\n` を取り除く。
- 1回の `tmux send-keys` で送った複数のキー(`Down Down Down h a b c BSpace Enter`)も、keypress が1つずつ順に出した。状態をふつうの変数に持てば、前のキーの変更を次のキーが読める(Ink の `useInput` で要った `useRef` の回避は要らない)。
- 終わるときは `\e[?2004l`、カーソルの表示、代替画面を抜ける列を書き、`setRawMode(false)` にする。

## 描画

- 画面全体を1回の `write` で書く:`\e[?2026h\e[H` + 各行の末尾に `\e[K` を付けて `\r\n` でつないだもの + `\e[J\e[?2026l`。消してから描かない。tmux は同期出力(mode 2026)をペインの単位で扱い、描きかけのコマを出さない(利用者が目で見て、ちらつかないことを確かめた)。
- **ヘッダも含めて、すべての行を端末の幅で切る。** 1行でも幅を超えると tmux が折り返し、画面が1行上にずれて、先頭に折り返した端(例:`WAITING` の `G` だけ)が残る。試作で実際に起きた。
- 画面の行数も端末の高さを超えてはならない。超えると同じく上にずれる。スクロールの窓を決めるときは、ヘッダ、`<n>/<総数>`、一覧の下の欄の分を差し引く。試作は窓を最小1行にしただけで、3行の端末ではヘッダが押し出された。PRODUCT.md の「ヘッダを画面から押し出さない」を守るには、それだけでは足りない。
- 幅は表示幅で数える。日本語の全角文字は2桁。書記素の単位で切る(`Intl.Segmenter`)。切ったあとに `…` を足すなら、その1桁も含めて幅に収める。試作の手書きの判定は近似なので、実装では `string-width` と `cli-truncate` を使ってよい。
- SIGWINCH を受けたら描き直す。`process.stdout.columns` と `rows` は、その時点で新しい値になっている。
- キーごとに描かず、`setImmediate` で1回にまとめる。60回の `↓` の連打で描画が60回を超えず、末尾で止まって行き過ぎなかった。
- 太字と薄字は解除の制御コードが同じ `\e[22m`(SGR 22 は「太字でも薄字でもない」)。薄い範囲の中で太字を閉じると、そのあとが薄くならない。薄くしたい範囲には太字や色を混ぜないか、閉じたあとで `\e[2m` を付け直す。

## 使わない道具

- Ink に戻すときの知見(`suspendTerminal`、`useInput` の state の閉じ込め、`pauseInput` が読み取りを止めない件)は、`git show cycle-5:.claude/skills/working-with-ink/SKILL.md` で読める。
