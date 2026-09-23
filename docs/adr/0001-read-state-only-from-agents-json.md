---
status: accepted
---

# Claude Code の状態は `claude agents --json` からだけ読む

whatnext はセッションの状態を `claude agents --json` の出力からだけ読む。
`~/.claude/jobs/` 以下のファイルは公式に「安定したインターフェースではない」と明記されており、`--json` はスクリプトからの利用を公式に想定した口だからである。
Agent View は research preview で画面やショートカットが変わりうるが、この口に限れば画面の変更に巻き込まれない。

## Considered Options

- **`~/.claude/jobs/` を直接読む**：`--json` にない情報（blocked になった時刻など）が取れる可能性はあるが、予告なく形式が変わりうるため却下した。
- **OTel を状態の出どころにする**：logs の送信は既定で5秒間隔、metrics は60秒間隔で遅く、`state` や `waitingFor` に当たる情報も流れていない。権限要求が表示された時点のイベントもない。

## Consequences

`--json` には「いつ今の状態になったか」がないため、待機時間は whatnext の観測から推定するしかない。
`--json` の行の形が変わったときは、段を決める規則を合わせて直す。
