# Claude Code の外部仕様（実測）

whatnext が頼る `claude` の振る舞いを、実機での実測と公式ドキュメントから記録する。特に断りのない行は Claude Code 2.1.280 での実測。`claude` の更新で変わりうるので、食い違いを見つけたら実測し直してこの表を直す。

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
| 存在しないモデル名で `--bg` を起動するとどうなるか | 終了コード 0 で `backgrounded · <id>` を返し、起動の時点ではモデル名を検査しない。セッションはすぐに `state: "failed"`、`status: "idle"`、`pid` ありになる。`claude stop` のあとも `failed` のまま残る |
| `pid` のない `blocked` の行に `claude attach` するとどうなるか | 最初の応答の前に止まったセッションでは、`Couldn't wake <id> — This session has no saved transcript …` と出して終了コード 1 で終わり、起き直らない。やり直すコマンドとして `claude respawn <id>` がある |
| 信頼されていないディレクトリで `--bg` を起動するとどうなるか | 終了コード 1 で 「Workspace not trusted. Run claude in &lt;dir&gt; once and accept the trust prompt, then retry.」 と出して断る。一度起動できたディレクトリでも、`git worktree add` のあとに断られたことがある（理由は未確認） |
| `--json` に PR の情報はあるか | ない（公式ドキュメント agent-view のフィールド表による）。Agent View の PR ラベルは画面だけの表示で、Claude Code が `gh`（`gh pr view` など）で結び付けたもの。whatnext が PR を出すには自分で `gh` を呼ぶしかない |
| `claude stop` の直後に `claude rm` を打つとどうなるか（2.1.281） | worktree のセッションでは、`stop` が止めたプロセスの終了を待たずに戻るので、`kept <id> — its worktree is still at …` とロックの理由を出して、終了コード 1 で断る。数秒後なら `removed <id>` で worktree ごと消える。リポジトリ本体で動くセッションでは起きない |
| `claude rm` の強制系のオプション（2.1.281） | `--discard-unpushed <commit>@<worktree-id>` は未 push のコミットと未コミットの変更を捨てて消す。`--force-remove-worktree <worktree-id>` は hook や git が worktree を消せなかったときに消す。どちらも値は直前の `claude rm` が出力したものを渡す。プロセスが終わっていないことによるロックを外すオプションはない |
| `--bg` が作る worktree はどこに置かれるか | `<repo>/.claude/worktrees/<名前>`。ignore していないリポジトリでは `git status` に `?? .claude/` と出て、`git add -A` で worktree が gitlink として紛れ込みうる。ignore（グローバルの `core.excludesFile` が手軽）は利用者が足す。whatnext は書き込まない |
| プロンプトなしで `--bg` を起動するとどうなるか（2.1.281） | 終了コード 0 で `backgrounded · <id> · <name> (idle — send a prompt to start)` を返す。`--json` では `state: "blocked"`、`status: "idle"`、`pid` あり、`waitingFor` なしになる。`--name` なしのときの `name` は未確認 |
| worktree で作業した `--bg` のセッションはコミットするか（2.1.281） | する。worktree のブランチに自分でコミットを残す。そのため、止めたあとの `claude rm` は `1 unpushed commit ... deleting the worktree would lose it` と断るのが普通になり、push するか `--discard-unpushed <commit>@<worktree-id>` を渡すよう案内する |
| `--name` なしで起動したセッションの `name`（2.1.281） | 最初はプロンプトの先頭になり、最初のターンを終えると内容を要約した名前に付け直される。名前は変わるので、行の特定には `id` を使う。プロンプトなしで起動したときの名前は未確認 |
