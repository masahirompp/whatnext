---
status: accepted
---

# whatnext が起動したセッションにはフックと OTel を付け、起動している間だけ受ける

[ADR-0006](0006-receive-otel-from-launched-sessions.md) の改訂版。サイクル3で、セッションの今の様子と待機時間をフックから取るようにし、COST の列をやめた。

whatnext が `n` で起動するセッションには、`claude --bg --settings` でフックと OTel の設定を付ける。送り先は、whatnext が `127.0.0.1:14318` で開く受け口にする。
whatnext は起動している間だけ受け口を開き、受けた値はメモリにだけ持つ。
段は引き続き `--json` だけで決める（[ADR-0001](0001-read-state-only-from-agents-json.md)）。

- **フック**（`UserPromptSubmit`、`Stop`、`StopFailure`、`PermissionRequest`、`PreToolUse` の `AskUserQuestion`）：行の一言、待機時間の推定、保留を解くかの判断に使う。フックは段が変わる瞬間に発火するので、観測による推定より正確で、権限待ちの時刻も取れる。
- **OTel**（logs だけ）：CTX の列に使う。サイクル3では、フックとの待機時間のずれを見るためにも使った。オプトインの機能として続けるか廃止するかは、まだ決めていない。

フックの種類は `command` にし、コマンドは `curl -s -m 1 -o /dev/null --data-binary @- http://127.0.0.1:14318/v1/hooks; exit 0` とする。
送れなくても何も出力せずに終了コード 0 で終わるので、whatnext を閉じている間もセッションの画面にエラーが出ず、`PermissionRequest` に判断を返すこともない（[ADR-0003](0003-no-input-injection-or-proxy-response.md)）。
`--settings` はそのセッションの起動の引数で、利用者の設定ファイルは書き換えない（[ADR-0002](0002-no-writes-no-persistent-state.md)）。

## Considered Options

- **`http` のフック**：受け口が閉じていると、セッションの画面に `Stop hook error: connect ECONNREFUSED` が出続ける。sandbox のプロキシや組織の設定 `allowedHttpHookUrls` の影響も受ける。
- **whatnext に同梱した転送用スクリプトを Node で動かす `command` のフック**：whatnext を入れ直してスクリプトのファイルが消えると、起動済みのセッションにエラーが出た。
- **`npx` で whatnext のサブコマンドを呼ぶ**：解決だけで 0.3〜1.3 秒かかり、権限の確認の表示を遅らせる。
- **フックの一言をモデルで要約する**：将来のオプトインの機能として検討する。今は最後の応答の冒頭をそのまま出す。
- **COST の列**：サイクル2で OTel の metrics から出していたが、CTX があれば足りると利用者が判断してやめた。metrics は受けない。
- ADR-0006 の Considered Options（外部のメトリクス基盤、外で起動したセッションの起動し直し、利用者の設定ファイルの書き換え）は、そのまま当てはまる。

## Consequences

- whatnext の外で起動したセッションと対話セッションには、フックと OTel が届かない。一言と待機時間は会話記録で補い（[ADR-0011](0011-fill-in-from-transcripts-when-hooks-are-missing.md)）、CTX は `-` になる。User Story 12 の例外は CTX の列だけである。
- whatnext を閉じている間に発火したフックは失われる。開き直した直後の一言と待機時間は、会話記録で補う。
- 受け口のポートは固定なので、whatnext は同時に1つだけ動かす。2つ目は、そのことを示して終了する。
- 受け口を開けなかったとき（別のプログラムがポートを使っている）は、起動するセッションにフックと OTel を付けない（DESIGN.md「OTel の受信」）。付けると、指示と応答の全文を知らないプログラムに送り続ける。
- フックのたびに `curl` のプロセスが1つ立つ。`curl` は [ADR-0008](0008-dependencies-and-contact-points-with-tmux.md) で基本コマンドとして扱う。
