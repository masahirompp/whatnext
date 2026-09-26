# Claude Code の外部仕様（実測）

whatnext が頼る `claude` の振る舞いを、実機での実測と公式ドキュメントから記録する。特に断りのない項目は Claude Code 2.1.280 での実測。`claude` の更新で変わりうるので、食い違いを見つけたら実測し直してこの文書を直す。

## `claude agents --json` の行の形（2.1.281）

出力は行の配列で、1行が1セッション。状態ごとの実際の行（匿名化済み）は `docs/claude-agents-json.samples.json` にある。今の `claude` との差分は `.claude/skills/checking-claude-cli/check-agents-json.mjs` で確かめる。

| キー | 型 | `background` | `interactive` | 値と意味 |
| --- | --- | --- | --- | --- |
| `kind` | string | ○ | ○ | `"background"`（`--bg` で起動）か `"interactive"`（通常の `claude` や ACP） |
| `sessionId` | string | ○ | ○ | UUID。同じ値の行が `background` と `interactive` の両方に出ることがある |
| `id` | string | ○ | なし | `sessionId` の先頭 8 文字。`claude attach` / `stop` / `rm` に渡す |
| `cwd` | string | ○ | ○ | 作業ディレクトリ。worktree に移るとそのパスに変わる |
| `name` | string | ないことがある | ○ | `--name` の値、なければ自動の名前（変わりうる）。2.1.282 で、`state: stopped` の行と、`pid` のない `state: blocked` の行に `name` キーがないものを見た。ないときは `id` を名前として扱う |
| `startedAt` | number | ○ | ○ | エポックミリ秒。`claude stop` のあとは値がわずかに変わる（1秒未満）ので、行の特定には使わない |
| `pid` | number | 動いている間だけ | ○ | 止まったセッションにはキーごとない |
| `state` | string | ○ | なし | `working` / `done` / `blocked` / `failed` / `stopped` |
| `status` | string | 動いている間だけ | ○ | `busy` / `idle` / `waiting` |
| `waitingFor` | string | 待っている間だけ | 待っている間だけ | `"permission prompt"` / `"input needed"` / `"sandbox request"` / `"worker request"` / `"dialog open"`（公式ドキュメント）。実機で見たのは最初の3つ（`"sandbox request"` は 2.1.283） |

- 値が `null` の行は見ていない。ないときはキーごと省かれる。
- 動いている `background` の行の組み合わせ: 作業中は `working` + `busy`、ターン終了後は `done` + `idle`、プロンプトなしで起動した直後は `blocked` + `idle`、権限待ちは `blocked` + `waiting` + `waitingFor`、失敗は `failed` + `idle`。
- 止めたあとは `pid` と `status` が消え、`state` は `done` と `failed` がそのまま、`blocked` は `stopped` になる。`working` の最中に止めたときは未確認。

## 振る舞い

`waitingFor` の値と、止めたあとの `state` は、上の「行の形」の節にある。

### `--json` の中身

- 対話セッションも出る。通常の `claude` で起動したものも ACP 経由のものも `kind: "interactive"` で、`id` と `state` がなく、`status`、`waitingFor`、`pid` を持つ。
- 通常の `claude` の権限待ちも出る。確認ダイアログの表示中は `status: "waiting"`、`waitingFor: "permission prompt"` になる。
- 対話セッションがターンを終えたあとは `status: "idle"` で、開いているだけのセッションと区別できない。
- `--name` の値は `name` に出る。`--name` なしのときは、最初はプロンプトの先頭で、最初のターンを終えると内容を要約した名前に付け直される。プロンプトなしで起動したときは、最初は `id` と同じ値になる（2.1.281）。名前は変わるので、行の特定には `id` を使う。
- PR の情報はない（公式ドキュメント agent-view のフィールド表による）。Agent View の PR ラベルは画面だけの表示で、Claude Code が `gh`（`gh pr view` など）で結び付けたもの。whatnext が PR を出すには自分で `gh` を呼ぶしかない。
- 実行時間は約 135 ms（6〜8 行の時点）。

### 起動（`--bg`）

- プロンプトなしで起動すると、終了コード 0 で `backgrounded · <id> · <name> (idle — send a prompt to start)` を返す。`--json` では `state: "blocked"`、`status: "idle"`、`pid` あり、`waitingFor` なしになる（2.1.281）。
- バックグラウンドのサービスが止まっている状態で、プロンプト付きの `claude --bg` を実行すると、`Starting background service…` に続いて `backgrounded · <id> · <name>` が出た。そのセッションは1分以上 `blocked` + `idle` + `pid` ありのままで、最初のターンが始まらなかった。直後に続けて起動した3つは正常だった。1回だけの観測で、原因は確かめていない（サービスの起動と重なった最初の1つだけで起きた可能性）（2.1.282）。whatnext の `n` はプロンプトなしで起動するので直接の影響はないが、プロンプト付きで起動する外部 watcher には影響しうる。
- 起動の出力（`backgrounded · <id> …`）には `id`（`sessionId` の先頭 8 文字）だけがあり、`sessionId` はない。起動したセッションを `sessionId` で扱うには、次に `--json` を読んで `id` から引く。
- 存在しないモデル名でも、終了コード 0 で `backgrounded · <id>` を返し、起動の時点ではモデル名を検査しない。プロンプトを付けて起動すると、セッションはすぐに `state: "failed"`、`status: "idle"`、`pid` ありになる。プロンプトなしでは最初のターンが来ないので `blocked` のまま（2.1.281）。`claude stop` のあとも `failed` のまま残る。
- `--model` の別名（`fable` / `opus` / `sonnet` など）は、そのファミリーの最新モデルを指す（`claude --help` の説明）。フルネームも受け付ける。モデルの一覧を取る公式の口はない。
- 信頼されていないディレクトリでは、終了コード 1 で「Workspace not trusted. Run claude in &lt;dir&gt; once and accept the trust prompt, then retry.」と出して断る。一度起動できたディレクトリでも、`git worktree add` のあとに断られたことがある（理由は未確認）。
- `claude --bg --help` はヘルプを出さず、プロンプトなしの `--bg` セッションを起動する。`--bg` のオプションは `claude --help` で調べる（2.1.281）。
- `claude -r <sessionId> --bg` は、`claude stop` のあとなら同じ `id` で続く。稼働中（`done` で待機中を含む）ならコピーが作られ、コピーには `--name` が引き継がれない。

### attach

- 離脱キーは Ctrl+Z でシェルに戻る（`claude attach --help` に記載）。`←` は Agent View に戻る。
- `claude attach --help` の説明は「← returns to agent view, Ctrl+Z drops back to your shell. The session keeps running either way.」。attach の中で空のプロンプトの ← を押すと Agent View に入り、端末のタイトル（tmux の `pane_title`）が `claude agents`、続いて `1 awaiting input · claude agents` に変わる。Agent View から `Enter` でセッションに戻ると、タイトルはセッション名に戻る。セッションの画面にいる間、タイトルは tmux の既定（ホスト名）のことがある。← で変わるのは attach のクライアントだけで、セッション本体の `--json` の値は変わらない（2.1.283）。
- `--bg` でない普通の `claude`（対話セッション）にも `← for agents` がある。空のプロンプトで ← を押すと Agent View に入り、「Your conversation moved to the background」と出て、会話が新しい `background` のセッションに移る。`--json` からは元の `interactive` の行が消え、新しい `id` と `pid` を持つ `background` の行（`blocked` + `idle`）ができる。名前は引き継がれず、`id` と同じ値になる（2.1.283）。
- 同じセッションに `claude attach` を2つ同時につなげる。後からつないでも先のクライアントは切れず、両方に同じ画面が出る。一方を Ctrl+Z で離脱しても、もう一方はつながったまま。`claude attach` 1本あたり RSS は約 140MB（2.1.283、tmux 3.7c）。
- attach していても `--json` の `state` / `status` は変わらない（クライアント0・1・2本、recap の生成後のいずれでも同じ）。
- ウィンドウの大きさを変えると、claude は画面を描き直し、折り返しも追従する。
- 処理中は入力欄の上に `✽ <動詞>… (27s · ↓ 2.5k tokens)` が出て、終わると `✻ <動詞> for 27s · done 11:35 AM` に変わる。権限待ちでは、実行しようとしているコマンドと選択肢がそのまま画面に出る。
- whatnext の子として動かした `claude attach` で Ctrl+Z を押すと、子が自分で終了する（終了コード 0、signal なし）。親は止まらず、端末のジョブ制御は働かない。attach から戻ったことは子の終了で分かる。
- attach して何も入力せずに離脱しても、`--json` の `state`、`status`、`waitingFor` は変わらない（`blocked` + `idle` で確認。2.1.282）。`done` や `waitingFor` のある状態で同じかと、OTel を送るセッションで attach しただけでイベントが飛ぶかは未確認。
- `pid` のない `blocked` の行に attach すると、2.1.281 では `Couldn't wake <id> — This session has no saved transcript …` と出して終了コード 1 で終わり、起き直らなかった（やり直すコマンドとして `claude respawn <id>` がある）。2.1.282 では、会話の記録があるセッションも、記録のない（プロンプトなしで起動してプロセスを `kill -9` で落とした）セッションも、attach で起き直り、離脱後は `blocked` + `idle` + `pid` ありになった。`Couldn't wake` は再現できなかった。
- `--bg` のセッションの権限要求に外部から答える口はない。`--permission-prompts` は `--print` 専用。
- `claude logs` の出力は解析できない。画面の再描画の制御コードそのもの。

### recap（away summary）（2.1.283）

- 端末のフォーカスが外れた状態で、ターンの終了から既定で3分（ただしプロンプトキャッシュが切れる前）たつと生成される。ユーザーのプロンプトが3回以上あり、前回の recap から2回以上増えていることが条件。API を呼ぶ。
- 常駐させたクライアントはフォーカスの通知を受けないので、放っておいても生成されなかった（3分半待った）。新しく attach しただけでも出ない。フォーカスが外れた通知（`ESC [O`）を送ると数秒で生成された。
- recap はセッションの記録に残り、あとからつないだクライアントにも出る。
- 強制的に生成させる非公式の経路として `~/.claude/jobs/<id>/recap.trigger` がある（本体の文字列 `RECAP_TRIGGER_FILE`）。jobs 以下は非公式なので使わない（ADR-0001）。

### worktree、停止、削除

- `--bg` は、設定 `worktree.bgIsolation: "worktree"` のとき、起動した時点では worktree を作らず、ファイルを編集する時点で `<repo>/.claude/worktrees/<名前>` に作って移る。`--json` の `cwd` もそのパスに変わる。`-w` を付けると起動した時点で作る（2.1.281）。
- worktree に移ったセッションを `claude stop` で止めると、`--json` の `cwd` は worktree のパスから元のリポジトリの根に戻る。worktree 自体は残る（`claude rm` の断りの文言に worktree のパスが出る）（2.1.282）。
- この worktree は、ignore していないリポジトリでは `git status` に `?? .claude/` と出て、`git add -A` で gitlink として紛れ込みうる。ignore（グローバルの `core.excludesFile` が手軽）は利用者が足す。whatnext は書き込まない。
- worktree で作業した `--bg` のセッションは、worktree のブランチに自分でコミットを残す。そのため、止めたあとの `claude rm` は `1 unpushed commit ... deleting the worktree would lose it` と断るのが普通になり、push するか `--discard-unpushed <commit>@<worktree-id>` を渡すよう案内する（2.1.281）。
- `claude rm` は worktree もブランチも消す。未 push のコミットか未コミットの変更があると断る（2.1.281）。
- `claude stop` の直後に `claude rm` を打つと、worktree のセッションでは、`stop` が止めたプロセスの終了を待たずに戻るので、`kept <id> — its worktree is still at …` とロックの理由を出して、終了コード 1 で断る。数秒後なら `removed <id>` で worktree ごと消える。リポジトリ本体で動くセッションでは起きない（2.1.281）。
- `claude rm` の強制系のオプション（2.1.281）：
  - `--discard-unpushed <commit>@<worktree-id>` は、未 push のコミットと未コミットの変更を捨てて消す。値は未 push のコミットがあるときにだけ、直前の `claude rm` が示す。
  - `--force-remove-worktree <worktree-id>` は、hook や git が worktree を消せなかったときに消す。追跡ファイルに未コミットの変更がないことが条件。
  - 未コミットの変更だけがあるときに使える強制系のオプションはない。プロセスが終わっていないことによるロックを外すオプションもない。

### Usage（2.1.282）

- アカウントの Usage は、`claude agents --json` にも `usage` サブコマンドにもない。OTel（monitoring-usage）にも枠の使用率やリセット時刻はない。
- `claude -p "/usage" --output-format json` は、モデルを呼ばずに約1.8秒で返る（`duration_api_ms: 0`、`local_command: "usage"`）。`result` は人間向けの文字列で、`Current session: 1% used · resets Sep 25 at 2:09pm (Asia/Tokyo)` と `Current week (all models): 25% used · resets Sep 29 at 9:59am (Asia/Tokyo)` の行に続いて、使用の内訳が付く。
- `--no-session-persistence` を付けないと、実行した場所に会話ファイルが残る。付けても、実行した場所に対応する空のプロジェクトのフォルダ（`~/.claude/projects/<場所>/memory/`）は一度作られる。
- stdin がパイプのまま閉じられていないと、3秒待って警告を出してから動く。呼ぶ側は stdin を閉じる。

### クラウドのセッションと過去のセッション

- クラウドのセッション（claude.ai/code、`--cloud`、routine）は `--json` に出ない。`kind` は `interactive` と `background` だけ。クラウドのセッションを一覧にする公式の CLI や JSON の出力もない（`--teleport` のピッカーと `/tasks` は対話専用）。`claude mcp serve` 経由の `ListAgents` は人向けの文字列で、`state`、`waitingFor`、attach 用の `id` を持たない。
- クラウドのセッションに端末から attach できない。`claude --cloud <id>` は「Attaching to an existing cloud session is not enabled for your account.」で断る。できるのは `claude -p "msg" --cloud <id>` で指示を送ることと、`--teleport` で手元に複製を作ることだけ。
- routine の実行の状態を読む公開 API はない（routine の公開 API は `/fire` だけで、トークンに読み取りの権限はない）。`claude mcp serve` が公開する `RemoteTrigger`（非公式で契約はない）の `list_runs` なら読めるが、終わった・返事を待っている・認証で失敗した、の3つがどれも `active` / `idle` になり、違いは最後の応答の文面にしか出ない（2026-09-24）。
- クラウドのセッションから手元のセッションに `SendMessage` できない。routine のセッションの `ListAgents` に手元のセッションは出ず、名前を指定して送っても届かない。逆向き（手元からクラウド）は届く。
- 過去のセッションの一覧を機械で読む口はない。選べるのは `claude --resume` の対話式のピッカーだけ。`claude agents --json --all` は、`--all` なしの結果に `done` と `stopped` の `background` の行を足す（2.1.283。2.1.282 で試したときは同じ行しか返らなかったが、そのとき該当する行がなかった可能性がある）。

## OTel（2.1.282）

- logs と metrics の属性 `session.id` は、`--json` の `sessionId`（UUID の全体）と一致する。
- metrics の属性：`session.id`、`model`（cost.usage / token.usage）、`query_source`、`type`、`terminal.type`、`start_type`（session.count）。
- `api_request` の属性：`model`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_creation_tokens`、`cost_usd`、`duration_ms`、`ttft_ms`、`request_id`、`speed`、`query_source`、`prompt.id`、`event.sequence`。本体のターンは `query_source` が `repl_main_thread` で始まる（output style があれば `repl_main_thread:outputStyle:custom`）。ほかに `prompt_suggestion` などがある。本体のターンの `input_tokens + cache_read_tokens + cache_creation_tokens` は、statusline のコンテキストの表示と一致した。
- metrics の既定の temporality は DELTA（`aggregationTemporality: 1`）。`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=cumulative` で累積（`2`）になる。累積のときは、止まっているセッションも送信間隔ごとに同じ累計を送り続けるので、受け手が途中から聞き始めても次の送信で累計がそろう。受け手が落ちていた間の送信は捨てられる。
- 権限待ちでは、最後のイベントは `hook_execution_complete`（`hook_event: PermissionRequest`）で、`--json` で `permission prompt` を観測する約0.7秒前だった。これは PermissionRequest フックがある環境での値で、フックがない環境で何が最後になるかは未確認（`api_request` か `assistant_response` と見られる）。`tool_decision` は利用者が応答したあとに出るので、止まり始めの印にならない。
- `hook_event: Notification` の `hook_execution_*` は、セッションがすでに待っている間に発火する。最後のイベントを待機の開始とみなすときは除かないと、開始の時刻が後ろにずれる。
- logs の到着は `OTEL_LOGS_EXPORT_INTERVAL` に従う（既定の 5000 なら最大5秒遅れる）。

### `--bg` のセッションに OTel の設定を渡す経路

| 経路 | 結果 |
| --- | --- |
| `claude --bg` を起動したシェルの環境変数 | 届かない（実測）。`--bg` はデーモンが事前に起こした `claude bg-spare` が引き受け、起動要求に載る環境変数は許可リスト（`CLAUDE_CONFIG_DIR`、モデル指定、プロバイダの設定、`PATH` など）だけ |
| `--settings '{"env":{...}}'` | 届く（実測）。`claude respawn` のあとも引き継がれる |
| プロジェクトの `.claude/settings.json` / `settings.local.json` の `env` | 届かない（実測。`--bg` でも `-p` でも）。プロジェクトの設定からは `OTEL_EXPORTER_OTLP_*` などを設定できない |
| デーモンの環境変数 | 届く見込み（未確認）。デーモンは最初に起動した `claude` の環境を持つので、どのシェルがデーモンを起こしたかに左右される |
| 利用者の `~/.claude/settings.json`、managed settings の `env` | 届く見込み（未確認） |

- 外で起動した `--bg` のセッションに、あとから OTel を付ける手段はない。`claude respawn <id>` はフラグを取らず、保存済みの起動時の引数で起動し直す。止めてから `claude --bg --resume <sessionId> --settings '...'` とすると、別の ID のコピーが起動し、元のセッションも残る。
- 同じ版での `claude respawn` は、プロンプトキャッシュをほぼ捨てない（書き直しは 71 token だった）。版が変わる respawn は未確認。

## フック（2.1.283）

- `--bg` のセッションでも、`--settings` で渡したフックが動く。利用者の `~/.claude/settings.json` やプロジェクトの `.claude/settings.local.json` のフックと併せて動き、上書きされない（`Stop` で3つの出どころのフックがすべて動いた）。
- `http` のフックは、送り先が閉じているとセッションの画面に `Stop hook error: connect ECONNREFUSED 127.0.0.1:<port>` と `Stop hook error occurred · ctrl+o to see` を出す。`command` のフックが何も出力せず終了コード 0 で終われば、何も出ない。
- `http` のフックは、sandbox のプロキシを経由することがあり、組織の管理設定 `allowedHttpHookUrls` で送り先が制限されうる（`claude` の本体の文字列による。実際に届かない条件は未確認）。
- 入力の主な項目：
  - 共通：`session_id`（`--json` の `sessionId` と一致）、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name`。
  - `Stop`：`last_assistant_message`（最後の応答の全文。記録ファイルを読まずに済むように用意された項目）、`stop_hook_active`。
  - `StopFailure`：`error`、`error_details`、`last_assistant_message`。
  - `UserPromptSubmit`：`prompt`（全文）、`source`（`user` / `sdk` / `system` / `loop_wakeup` など）。`--name` を付けたときは `session_title` も付く。
  - `PermissionRequest`：`tool_name`、`tool_input`（`Bash` なら `command` と `description`）、`permission_suggestions`。
  - `PreToolUse`：`tool_name`、`tool_input`、`tool_use_id`。
  - `Notification`：`message`、`title`、`notification_type`。
- `PermissionRequest` の `command` フックが何も出力せず終了コード 0 で終わると、権限の確認はふだんどおりセッションに出る。
- フックの `command` はシェルで実行される。`… 2>/dev/null; exit 0` と書けば、コマンドが失敗しても何も出ない。コマンドが 0 以外で終わると、セッションの画面に `Stop hook error: Failed with non-blocking status code: <stderr>` と出る。
- 権限の確認で `No` を選ぶとターンが中断され（`Interrupted · What should Claude do instead?`）、`Stop` は発火しない。そのあと `--json` の行は `state: "working"`、`status: "idle"` のまま、次の指示でターンを終えるまで変わらない（90秒観測）。
- 端末のタイトル（tmux の `pane_title`）は `✳ <name>` で、要約にはならない。`--name` なしのときは、最初のターンの途中で一時的に内容の説明（例：`docs/adr の ADR ファイル一覧と ADR-0003 の内容確認`）が出てから、短い名前に変わった。
- sandbox に弾かれた Bash は `PostToolUseFailure` に入り、`tool_input.command` と `error` を持つ。`error` は `Exit code 7` のような終了コードだけで、sandbox が原因だという印はない（同じコマンドは sandbox の外では成功した）。モデル（haiku）の応答も、sandbox が原因だとは気づかなかった（2.1.283）。
- sandbox で `allowUnsandboxedCommands: false` のとき、許可していない接続先へのネットワークアクセスは `waitingFor: "sandbox request"` で止まる（2.1.283）。

### モデルへの指示（本体の文字列、2.1.283）

- 人にシェルのコマンドを動かしてもらう必要があるときは、プロンプトに `! <command>` と打つよう勧めよ、という指示がある（一部の構成では付かない）。
- sandbox の構成で `dangerouslyDisableSandbox` が無効なときは、「タスクに必要なコマンドが sandbox の制限で失敗したら、どの制限に当たったかを人に伝えよ。sandbox の設定を変えるのは人の判断」という指示がある。条件によって、「`/sandbox exclude <pattern>` で除外するか、`!` を付けて自分で動かすこと」が続く。
- SDK の説明には「ローカルの TUI の `!cmd` の経路は sandbox なし」とある。ただし、sandbox の設定で credential のファイルを読めなくしている環境では、`!` で打ったコマンドも読めずに失敗する（利用者の環境で繰り返し確認）。
- 公式ドキュメントに載っていないキー操作 `app:toggleTerminal`（既定のキーなし）がある。中身は確かめていない。
- どれも公開された仕様ではなく、版によって変わりうる。
