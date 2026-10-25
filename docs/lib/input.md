# 入力（`lib/input/`）

外部から観測を読む部品。どれも、失敗を例外にせず、値として返す（読めなければ空、`undefined`、`{ok: false}`）。仕組みは [DESIGN.md](../DESIGN.md)「フックの受信」「OTel の受信」「会話記録の読み取り」「機能ごとの入力の出どころ」にある。

## 外部コマンドの口（`exec.ts`）

- `run: Run`：`(cmd, args, opts?) => Promise<RunResult>`。`execFile` で動かし、終了コード（`code`、起動できなければ `null`）、`stdout`、`stderr`、`error` を返す。例外は投げない。`opts` は `cwd`、`timeout`（ミリ秒。既定は 30 秒）、`env`、`input`（標準入力に書く文字列）。
- テストでは `Run` を差し替える。`lib/` の部品で外部コマンドを動かすものは、すべて `Run` を引数で受け取る。
- `stripControl(s)`：コマンドの出力から、色などの CSI の列と OSC の列を除く。改行やタブなどの制御文字は残す。

## `claude agents --json` と Usage（`claude.ts`）

- `readAgents(run)`：`claude agents --json --all` を読み、`{ok: true, rows: JsonRow[]}` か `{ok: false, error}` を返す。`JsonRow` は `kind`、`sessionId`、`cwd` と、あれば `id`、`name`、`startedAt`、`pid`、`state`、`status`、`waitingFor`。null の項目は持たない。
- `parseAgents(text)`：同じ解析を文字列に対して行う。
- `fetchUsage(run, now?)`：`claude -p "/usage"` を一時ディレクトリで動かし（DESIGN.md「Usage の取得」）、`UsageFrame[]`（`label`、`percent`、`resets`）を返す。取れなければ `undefined`。`parseUsage(text, now)` は解析だけ。

## フックと OTel の受け口（`receiver.ts`、`hooks.ts`）

- `probe(port)`：受け口のポートを使っているのが、だれもいない（`free`）、whatnext（`whatnext`）、ほかのプログラム（`other`）のどれかを返す（`GET /v1/whatnext`）。
- `openReceiver(port, store)`：`127.0.0.1:<port>` で受け口を開き、`/v1/hooks` のフックと `/v1/logs` の OTel の logs を `store` に渡す。開けなければ `null`。`Receiver` は `close()` を持つ。
- `launchSettings(port)`：`n` で起動するセッションの `--settings` に渡す JSON（フック5種と OTel の `env`）。
- `HookStore`：受けた値をセッションごとにメモリに持つ。時刻は受け取った時刻（コンストラクタに時計を渡せる）。
  - `receiveHook(body)`、`receiveLogs(body)`：受けた値を足す。
  - `get(sid)` は `HookFacts`（`prompt`、`stop`、`failure`、`permission`、`question`。それぞれ時刻 `at` 付き）、`ctxOf(sid)` は CTX（本体のターンの最新の要求の token 数）。
  - `onEvent(listener)`：受けるたびに `(sid, event)` で呼ぶ。`forget(keep)`：`keep` にないセッションを忘れる。

## 会話記録（`transcript.ts`）

- `Transcripts`：`~/.claude/projects/*/<sessionId>.jsonl`（`CLAUDE_CONFIG_DIR` があればその下）を読む。読むだけで書かない。
  - `read(sid)`：更新時刻が変わったファイルだけを末尾から読み、`TranscriptFacts`（`prompt`、`haltAt`、`permission`、`question`、`declined`、`error`、`lastText`）を返す。なければ `undefined`。
  - `firstPrompt(sid, force?)`：最初の利用者の指示の1行目。一度見つけたら覚える。`force` で置き場所から探し直す。
  - `locate(sid)`、`forget(keep)`。
- 指示とみなす行、除く行、サイドチェーン、中断の扱いは [claude-code-behavior.md](../claude-code-behavior.md)「会話記録」にある。
- 未確認の観察が2件ある（#253、#244。DESIGN.md「確かめ方」、claude-code-behavior.md）。

## 補う値（`hooks.ts` の `supplement`）

- `supplement(hook, transcript, ctx)`：フックの値を主にし、今のターンの値がないときに会話記録で補った `Supplied`（`prompt`、`haltAt`、`permission`、`question`、`declined`、`error`、`lastText`、`ctx`）を返す。
- 今のターンの境は DESIGN.md「機能ごとの入力の出どころ」のとおり。フックの値はフックの指示の時刻以降だけ、会話記録の値はその指示がフックの指示の2秒前以降のときだけ使う（#267）。

## 文の切り出し（`text.ts`）

- `leadLine(text)`：最後の応答の冒頭（PRODUCT.md「一覧の表示」の規則）。`firstLine(text)`：空でない最初の行。
- `toolTarget(name, input)`：`<道具>: <対象>`。対象の項目の順と、項目がないときに入力の最初の文字列に落ちることは DESIGN.md「機能ごとの入力の出どころ」のとおり（#266）。対象がなければ道具の名前だけ。
- `instructionText(content)`：会話記録の利用者の行を指示の文字列にする。ターンを始めないコマンドなど、指示でなければ `undefined`。

## プロセス表（`procs.ts`）

- `readParents(run)`：`ps -A -o pid=,ppid=` を読み、pid から親の pid を引く表を返す。読めなければ空の表。`parseParents(text)` は解析だけ。
- 起動元の導き方（祖先をたどる、前回を持ち越す）は使う側が持つ（DESIGN.md「起動元の引き方」）。
