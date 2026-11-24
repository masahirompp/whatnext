---
status: accepted
---

> [ADR-0023](0023-digests-on-by-default.md) で一部を改訂した（#381）。ダイジェストは既定で有効になり、`--no-digest` で切る。`--digest` は消した。下の「`--digest` のとき」は「ダイジェストが有効なとき（`--no-digest` を付けないとき）」と読み、「そのためオプトインにし」は ADR-0023 が改めた。mod を配ること、置き場所と層、受け口との契約はこのままである。

# `--digest` のときは、`n` で起動するセッションに whatnext が配るダイジェストの mod を付ける

一言（最後の応答の冒頭、今の指示の冒頭）だけでは、並んだ行がそれぞれ何の作業で、どこまで進んだかを見比べられない（#325）。
そこで、whatnext は関数フックのプラグイン（mod）を npm の配布物に入れて配り、`whatnext --digest` で起動したときだけ、`n` で起動するセッションに `--plugin-dir` で付ける。
mod はターンの終わりに Haiku を1回呼んでダイジェスト（Goal・Progress・Next）を作り、会話リンク（会話に出た issue、PR、コミット、URL など）を拾い、セッションの中のペインに出し、whatnext の受け口に送る。
一覧はダイジェストと会話リンクをメモリにだけ持ち、行の一言の上の `◎ <Goal>` と、一覧の右の欄に出す。段にも並びにも使わない。

## 何に頼ることになるか

- **mod の API（Claude Code の早期公開版）**：`turn.complete` などのイベント、`$.model.complete`、`$.session.messages`、`$.ui.open`、`$.http.fetch`、`$.env.get`。型の宣言の先頭に「リリースの間で予告なく変わりうる」とある。whatnext が追従を引き受け、`claude` を更新したあとに確かめる対象に入れる（checking-claude-cli スキル）。mod の読み込みは Claude Code の段階的な公開のスイッチで決まり、スイッチが入っていない環境では mod が動かない。そのときは Goal の行も右の欄の中身も出ないだけで、一覧のほかの挙動は変わらない。
- **依存するコマンドは増えない**。[ADR-0008](0008-dependencies-and-contact-points-with-tmux.md) の「本体が依存するコマンドは `claude`、`git`、`tmux` だけ」は保つ。mod は `claude` の中で動き、受け口へは `claude` 自身が送る（フックと OTel と同じ。[ADR-0009](0009-receive-hooks-and-otel-from-launched-sessions.md)）。[ADR-0004](0004-depend-only-on-claude-and-git.md)（`claude` と `git` だけに頼る。ADR-0005、0008 で改訂済み）が守ろうとしたのは「依存先のない環境でも本体が同じように動くこと」で、`--digest` を付けなければ mod も API も使わないので、これは崩れない。崩れるのは「`claude` との接点はコマンド、フック、OTel、会話記録だけ」という見込みで、`--digest` のときだけ、そこに mod の API が加わる。
- **利用枠**：ダイジェストを付けたセッションは、ターンごとに Haiku を1回呼ぶ（`--digest` の whatnext がダイジェストを受けていないときは呼ばない。DESIGN.md「ダイジェストの mod」）。そのためオプトインにし、起動時のオプションで有効にする（PRODUCT.md「全体」の決まり）。

## 置き場所と層

mod のコードはリポジトリの根の `mod/` に置き、**永続層**とする（CLAUDE.md の層の定義）。

これは CLAUDE.md の昇格の決まり（仕様が収束したモジュールを、cycle-end に人間の承認を経て `lib/` に昇格する）の例外で、mod は昇格を経ずに初めから永続層に置く（2026-11-21、利用者が承認）。mod は npm の配布物に入り、`src/` とは別に Claude Code の中で動くので、cycle-end に `src/` と一緒に消すのは合わない。

- mod は whatnext を入れ直しても、すでに起動したセッションの中で動き続ける。受け口に送る本文の形（DESIGN.md「ダイジェストの受信」）は、版の違う whatnext どうしの契約になり、サイクルを跨いで保つ必要がある。
- mod の中身（ダイジェストを作る、会話リンクを拾う、ペインを描く）は一覧に依存しない末端の部品で、一覧を書き直すたびに書き直す理由がない（[ADR-0021](0021-promote-leaf-modules-to-lib.md) と同じ基準）。
- テストは `mod/tests/` に置き、`claude plugin test mod`（`npm run test:mod`）で流す。`src/` とテストを消しても残る。
- `lib/` には置かない。`lib/` は Node で動く一覧の部品で、`src/` からだけ使う。mod は Claude Code の中の別の実行環境（DOM も Node もない）で動き、ビルドもしない（`.tsx` のまま配る）。

## Considered Options

- **mod を使わず、whatnext が `claude -p` を呼んでダイジェストを作る**：`claude` だけに頼り、外で起動したセッションにも出せる。セッションの中で同じダイジェストを見られないので採らなかった。mod の API が使えなくなったときの代わりの案になる。
- **session-timeline を丸ごと同梱する**：たまにしか見ない工程のタイムラインのために、区間ごとの Haiku の呼び出しを全セッションで払う。
- **session-timeline のまとめを、whatnext の mod が名前で読んで送る**：whatnext は型を知らずに済むが、session-timeline を別に入れる必要があり、名前を変えると黙って壊れる。
- **skills から配る橋渡しのプラグイン**（masahirompp/skills#62）：配る場所が2つに分かれ、版がずれる。
- **mod を使い捨て層（`src/` の下）に置く**：サイクル末に消すと、受け口との契約と会話リンクを拾う規則（session-timeline から移した、実測の罠の多い部分）を毎回作り直すことになる。
- **受け口に別の口（`/v1/digest`）を足す**：`lib/input` の受け口と契約を変えることになる。今の `/v1/hooks` に `hook_event_name` の違う本文として送れば、lib の受け口がフックの本文を `HookStore` に渡す契約のまま、`src/` の側で抜き取れる（DESIGN.md「ダイジェストの受信」）。

## Consequences

- ダイジェストが届くのは `n` で起動したセッションだけである（フックと同じ）。外で起動したセッション、対話セッション、1回で終わる `claude -p` には出ない。
- whatnext を終了して起動し直すと、次のダイジェストが届くまで出ない（メモリにだけ持つ。[ADR-0002](0002-no-writes-no-persistent-state.md)）。
- mod は許可や入力の代行をしない（[ADR-0003](0003-no-input-injection-or-proxy-response.md)）。
- Claude Code は、書ける置き場所の mod に `.claude-plugin/types/` と `tsconfig.json` を書く。リポジトリでは `.gitignore` で外し、npm の配布物には入れない（`package.json` の `files`）。npm で入れた置き場所が書けるなら、そこにも書かれる。
- 見直す条件：mod の API が正式な公開になったとき、または大きく変わって追従の費用が見合わなくなったとき（代わりは、whatnext が `claude -p` でダイジェストを作る案）。
