# Claude Code の外部仕様（実測）

whatnext が頼る `claude` の振る舞いを、実機での実測と公式ドキュメントから記録する。特に断りのない行は Claude Code 2.1.280 での実測。`claude` の更新で変わりうるので、食い違いを見つけたら実測し直してこの表を直す。

## `claude agents --json` の行の形（2.1.281）

出力は行の配列で、1行が1セッション。状態ごとの実際の行（匿名化済み）は `docs/claude-agents-json.samples.json` にある。今の `claude` との差分は `.claude/skills/checking-claude-cli/check-agents-json.mjs` で確かめる。

| キー | 型 | `background` | `interactive` | 値と意味 |
| --- | --- | --- | --- | --- |
| `kind` | string | ○ | ○ | `"background"`（`--bg` で起動）か `"interactive"`（通常の `claude` や ACP） |
| `sessionId` | string | ○ | ○ | UUID。同じ値の行が `background` と `interactive` の両方に出ることがある |
| `id` | string | ○ | なし | `sessionId` の先頭 8 文字。`claude attach` / `stop` / `rm` に渡す |
| `cwd` | string | ○ | ○ | 作業ディレクトリ。worktree に移るとそのパスに変わる |
| `name` | string | ○ | ○ | `--name` の値、なければ自動の名前（変わりうる） |
| `startedAt` | number | ○ | ○ | エポックミリ秒。`claude stop` のあとは値がわずかに変わる（1秒未満）ので、行の特定には使わない |
| `pid` | number | 動いている間だけ | ○ | 止まったセッションにはキーごとない |
| `state` | string | ○ | なし | `working` / `done` / `blocked` / `failed` / `stopped` |
| `status` | string | 動いている間だけ | ○ | `busy` / `idle` / `waiting` |
| `waitingFor` | string | 待っている間だけ | 待っている間だけ | `"permission prompt"` / `"input needed"` / `"sandbox request"` / `"worker request"` / `"dialog open"`（公式ドキュメント）。実機で見たのは最初の2つ |

- 値が `null` の行は見ていない。ないときはキーごと省かれる。
- 動いている `background` の行の組み合わせ: 作業中は `working` + `busy`、ターン終了後は `done` + `idle`、プロンプトなしで起動した直後は `blocked` + `idle`、権限待ちは `blocked` + `waiting` + `waitingFor`、失敗は `failed` + `idle`。
- 止めたあとは `pid` と `status` が消え、`state` は `done` と `failed` がそのまま、`blocked` は `stopped` になる。`working` の最中に止めたときは未確認。

## 振る舞い

| 問い | 結果 |
| --- | --- |
| `--json` に対話セッションは出るか | 出る。通常の `claude` で起動したものも ACP 経由のものも `kind: "interactive"` で、`id` と `state` がなく、`status`、`waitingFor`、`pid` を持つ |
| 通常の `claude` の権限待ちは `--json` に出るか | 出る。確認ダイアログの表示中は `status: "waiting"`、`waitingFor: "permission prompt"` になる |
| 対話セッションのターン終了後の状態 | `status: "idle"`。開いているだけのセッションと区別できない |
| `waitingFor` の実値 | 公式ドキュメント（agent-view）の値は `"permission prompt"` / `"input needed"` / `"sandbox request"` / `"worker request"` / `"dialog open"` の5つ。実機で確認したのは最初の2つ |
| `--name` は `name` に反映されるか | 反映される |
| `--json` の実行時間 | 約 135 ms（6〜8 行の時点） |
| `claude -r <sessionId> --bg` は同じ `id` で続くか | `claude stop` のあとなら続く。稼働中（`done` で待機中を含む）ならコピーが作られ、コピーには `--name` が引き継がれない |
| `claude logs` の出力は解析できるか | できない。画面の再描画の制御コードそのもの |
| 停止したセッションの `state` | `claude stop` のあと、`done` は `done` のまま、`blocked` は `stopped` になる |
| `claude attach` の離脱キー | Ctrl+Z でシェルに戻る（`claude attach --help` に記載）。`←` は Agent View に戻る |
| `--bg` のセッションの権限要求に外部から答える口 | ない。`--permission-prompts` は `--print` 専用 |
| `--bg` は worktree を作るか（2.1.281） | 設定 `worktree.bgIsolation: "worktree"` のとき、起動した時点では作らず、ファイルを編集する時点で `<repo>/.claude/worktrees/<名前>` に作って移る。`--json` の `cwd` もそのパスに変わる。`-w` を付けると起動した時点で作る。`claude rm` は worktree もブランチも消し、未 push のコミットがあると断る |
| whatnext の子として動かした `claude attach` で Ctrl+Z を押すとどうなるか | 子が自分で終了する（終了コード 0、signal なし）。親は止まらず、端末のジョブ制御は働かない。attach から戻ったことは子の終了で分かる |
| 存在しないモデル名で `--bg` を起動するとどうなるか | 終了コード 0 で `backgrounded · <id>` を返し、起動の時点ではモデル名を検査しない。プロンプトを付けて起動すると、セッションはすぐに `state: "failed"`、`status: "idle"`、`pid` ありになる。プロンプトなしでは最初のターンが来ないので `blocked` のまま（2.1.281）。`claude stop` のあとも `failed` のまま残る |
| `pid` のない `blocked` の行に `claude attach` するとどうなるか | 最初の応答の前に止まったセッションでは、`Couldn't wake <id> — This session has no saved transcript …` と出して終了コード 1 で終わり、起き直らない。やり直すコマンドとして `claude respawn <id>` がある |
| 信頼されていないディレクトリで `--bg` を起動するとどうなるか | 終了コード 1 で 「Workspace not trusted. Run claude in &lt;dir&gt; once and accept the trust prompt, then retry.」 と出して断る。一度起動できたディレクトリでも、`git worktree add` のあとに断られたことがある（理由は未確認） |
| `--json` に PR の情報はあるか | ない（公式ドキュメント agent-view のフィールド表による）。Agent View の PR ラベルは画面だけの表示で、Claude Code が `gh`（`gh pr view` など）で結び付けたもの。whatnext が PR を出すには自分で `gh` を呼ぶしかない |
| `claude stop` の直後に `claude rm` を打つとどうなるか（2.1.281） | worktree のセッションでは、`stop` が止めたプロセスの終了を待たずに戻るので、`kept <id> — its worktree is still at …` とロックの理由を出して、終了コード 1 で断る。数秒後なら `removed <id>` で worktree ごと消える。リポジトリ本体で動くセッションでは起きない |
| `claude rm` の強制系のオプション（2.1.281） | `--discard-unpushed <commit>@<worktree-id>` は未 push のコミットと未コミットの変更を捨てて消す。`--force-remove-worktree <worktree-id>` は hook や git が worktree を消せなかったときに消す。どちらも値は直前の `claude rm` が出力したものを渡す。プロセスが終わっていないことによるロックを外すオプションはない |
| `--bg` が作る worktree はどこに置かれるか | `<repo>/.claude/worktrees/<名前>`。ignore していないリポジトリでは `git status` に `?? .claude/` と出て、`git add -A` で worktree が gitlink として紛れ込みうる。ignore（グローバルの `core.excludesFile` が手軽）は利用者が足す。whatnext は書き込まない |
| プロンプトなしで `--bg` を起動するとどうなるか（2.1.281） | 終了コード 0 で `backgrounded · <id> · <name> (idle — send a prompt to start)` を返す。`--json` では `state: "blocked"`、`status: "idle"`、`pid` あり、`waitingFor` なしになる。`--name` なしのときの `name` は未確認 |
| worktree で作業した `--bg` のセッションはコミットするか（2.1.281） | する。worktree のブランチに自分でコミットを残す。そのため、止めたあとの `claude rm` は `1 unpushed commit ... deleting the worktree would lose it` と断るのが普通になり、push するか `--discard-unpushed <commit>@<worktree-id>` を渡すよう案内する |
| `--name` なしで起動したセッションの `name`（2.1.281） | 最初はプロンプトの先頭になり、最初のターンを終えると内容を要約した名前に付け直される。名前は変わるので、行の特定には `id` を使う。プロンプトなしで起動したときの名前は未確認 |
| アカウントの Usage を取る口はあるか（2.1.282） | `claude agents --json` にも `usage` サブコマンドにもない。`claude -p "/usage" --output-format json` はモデルを呼ばずに約1.8秒で返り（`duration_api_ms: 0`、`local_command: "usage"`）、`result` に人間向けの文字列が入る。`Current session: 1% used · resets Sep 25 at 2:09pm (Asia/Tokyo)` と `Current week (all models): 25% used · resets Sep 29 at 9:59am (Asia/Tokyo)` の行に続いて、使用の内訳が付く。`--no-session-persistence` を付けないと実行した場所に会話ファイルが残る。付けても、実行した場所に対応する空のプロジェクトのフォルダ（`~/.claude/projects/<場所>/memory/`）は一度作られる。stdin がパイプのまま閉じられていないと、3秒待って警告を出してから動くので、呼ぶ側は stdin を閉じる。OTel（monitoring-usage）にも枠の使用率やリセット時刻はない |
