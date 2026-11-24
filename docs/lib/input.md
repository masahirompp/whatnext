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
  - `UserPromptSubmit` の `prompt` は、会話記録の利用者の行と同じく `instructionText` で指示の文字列にする。指示でない（`undefined`。タスクの通知の `<task-notification>` で始まる本文など）ときは、`prompt` を前の指示のまま残す（#361）。指示でなくても新しいターンは始まるので、どちらのときも `turnAt` をその時刻にし（`prompt` が文字列でなければ、`prompt` とともに消す）、`stop`、`failure`、`permission`、`question` を消す。消さないと、前のターンの終わりの値が今のターンの値として一覧に出る。
  - `get(sid)` は `HookFacts`（`prompt`、`stop`、`failure`、`permission`、`question`。それぞれ時刻 `at` 付き。と、今のターンが始まった時刻 `turnAt`）、`ctxOf(sid)` は CTX（本体のターンの最新の要求の token 数）。
  - `onEvent(listener)`：受けるたびに `(sid, event)` で呼ぶ。`forget(keep)`：`keep` にないセッションを忘れる。

## 会話記録（`transcript.ts`）

- `Transcripts`：`~/.claude/projects/*/<sessionId>.jsonl`（`CLAUDE_CONFIG_DIR` があればその下）を読む。読むだけで書かない。
  - `read(sid)`：更新時刻が変わったファイルだけを末尾から読み、`TranscriptFacts`（`prompt`、`haltAt`、`permission`、`question`、`error`、`lastText`）を返す。なければ `undefined`。
  - `createdAt(sid)`：会話記録の先頭から、`timestamp` を持つ最初の行の時刻（エポックミリ秒）。セッションを作った時刻として使う。先頭から最大 2MB を読み、一度見つけたら覚える。ファイルがない、時刻のある行がないときは `undefined`。時刻のある行がなかったときは、ファイルの大きさが変わるまで読み直さない。
  - `new Transcripts(configDir)`：`configDir` は `projects` を含む置き場所（`CLAUDE_CONFIG_DIR`、なければ `~/.claude`）。呼ぶ側が決めて渡す。
  - `locate(sid)`：会話記録のファイルのパスを返す Promise。見つからない、または置き場所を読めないときは `undefined`。
  - `forget(keep)`：`keep` にないセッションの覚えた値を捨てる。
- 指示の行（`instructionText` が文字列を返す `user` の行）で、`prompt` をその指示にし、ターンの値（`haltAt`、`permission`、`question`、`error`、`lastText`）を消す。
- タスクの通知でターンが始まった行（`user` の行で、`turnOrigin` が `task_notification`、本文が指示でない文字列）でも、ターンの値を消す。`prompt` は前の指示のまま残す。`HookStore` が通知の `UserPromptSubmit` で `turnAt` を進めるのと同じ規則で、消さないと、フックのないセッションで前のターンの `lastText` が通知のターンの値として出る（#387）。
- 通知の行でも、記録にだけ残ってターンを始めなかったもの（`queueTranscriptOnly: true`。`turnOrigin` を持たない）は境にしない。境にすると、応答を返し終えたセッションの `lastText` が、ターンが始まっていないのに消える。
- `turnOrigin` を確かめたのは `claude` の 2.1.295〜2.1.331 で、`turnOrigin` を書かない版の会話記録では通知の行が境にならず、前のターンの値が残る（#387 の前と同じ見え方になる）。
- 権限の確認で断ったかどうかは見分けない。断った `tool_result`（`is_error` が `true` で、`The user doesn't want to proceed with this tool use.` で始まる）も、ほかの結果と同じく、結果のない `tool_use` を消すだけである。断った道具を値として返さない（`Declined:` の表示をやめた。#394）。
- 指示とみなす行、除く行、サイドチェーン、中断と通知の行の形は [claude-code-behavior.md](../claude-code-behavior.md)「会話記録」にある。
- 未確認の観察が2件ある（#253、#244。DESIGN.md「確かめ方」、claude-code-behavior.md）。

## 補う値（`hooks.ts` の `supplement`）

- `supplement(hook, transcript, ctx)`：フックの値を主にし、今のターンの値がないときに会話記録で補った `Supplied`（`prompt`、`haltAt`、`permission`、`question`、`error`、`lastText`、`ctx`）を返す。
- 今のターンの境は DESIGN.md「機能ごとの入力の出どころ」のとおり。フックの値は `turnAt`（なければフックの指示の時刻）以降だけ、会話記録の値はその指示が `turnAt` の2秒前以降のときだけ使う（#267）。指示は `prompt` で選ぶので、タスクの通知で始まったターンでも一言は前の指示のまま、前のターンの値は使わない（#361）。フックの値がないセッションでは、会話記録の値をそのまま使う。通知で始まったターンの境は `Transcripts` が引くので、`supplement` は会話記録のターンの始まりの時刻を受け取らない（#387）。

## 文の切り出し（`text.ts`）

- `leadLine(text)`：最後の応答の冒頭（PRODUCT.md「一覧の表示」の規則）。`firstLine(text)`：空でない最初の行。
- `promptLine(text)`：指示の冒頭（PRODUCT.md「一覧の表示」の稼働中の規則）。貼り付けのタグ（`<pasted_content id="X">` から、同じ id の `</pasted_content id="X">` まで。Claude Code は中身をそのままタグの間に入れるとみなし、中身に別の id の閉じるタグがあってもそこで切らない。タグを含む中身の貼り付けは確かめていない）の外の、空でない最初の行。外に何もなければ、最初の貼り付けの中身の、空でない最初の行。中身も空の行だけなら空の文字列（指示に数え、前の指示の一言を残さない）。タグを含まなければ `firstLine` と同じ（#291）。`instructionText` がこれを使う（フックの `prompt` も `instructionText` を通す）。
- `toolTarget(name, input)`：`<道具>: <対象>`。対象の項目の順と、項目がないときに入力の最初の文字列に落ちることは DESIGN.md「機能ごとの入力の出どころ」のとおり（#266）。対象がなければ道具の名前だけ。
- `instructionText(content)`：会話記録の利用者の行とフックの `prompt` を指示の文字列（`promptLine` で取った1行）にする。ターンを始めないコマンドなど、指示でなければ `undefined`。

## プロセス表（`procs.ts`）

- `readParents(run)`：`ps -A -o pid=,ppid=` を読み、pid から親の pid を引く表を返す。読めなければ空の表。`parseParents(text)` は解析だけ。
- 起動元の導き方（祖先をたどる、前回を持ち越す）は使う側が持つ（DESIGN.md「起動元の引き方」）。
