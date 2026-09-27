---
name: checking-claude-cli
description: whatnext が頼る `claude` CLI の出力(特に `claude agents --json` の行の形)をコードに書く前、またはサイクルの開始時・`claude` の更新後に読む。実機を一から調べ直さず、記録済みの見本との差分だけを確かめる手順と、状態ごとの行を安く作る方法。
---
# `claude` の出力を確かめる

## まず記録を読む
- 行の形(キー・型・値): `docs/claude-code-behavior.md` の「`claude agents --json` の行の形」と、見本 `docs/claude-agents-json.samples.json`。
- 振る舞い(いつどの値になるか): 同じ docs の「振る舞い」節(話題ごとの箇条書き)。
- 型はこの記録から書く。実機で形を調べ直さない。

## 差分を確かめる(サイクルの開始時、`claude --version` が見本の `claudeVersion` と違うとき)
```sh
node .claude/skills/checking-claude-cli/check-agents-json.mjs
```
- 今の `claude agents --json --all` のキー・型・`kind`/`state`/`status`/`waitingFor` の値を見本と比べる。終了コード 0 は新しいものなし、1 は見本にないものあり。
- `not seen this time` は今その状態の行がないだけのことが多い。気になるときだけ下の方法で行を作る。
- スクリプトは見本にない値やキーを検出するが、キーが欠けていることは検出しない（`not seen this time` とだけ出る）。常にあると記録しているキーが `not seen` なら、欠けた行がないかを目で確かめる。
- 差分が出たら、その項目だけ調べて docs の表・見本・スクリプトの前提を直し、`claudeVersion` を上げる。`learning` の issue も起票する。

## 会話記録の形を確かめる(同じとき)
- whatnext が会話記録に頼る項目は `docs/claude-code-behavior.md` の「会話記録」節にある(ADR-0011 で範囲を限っている)。
- 権限待ちの行を1つ作り(下の方法)、`~/.claude/projects/*/<sessionId>.jsonl` の末尾に、指示の `user` の行(`message.content` が文字列)と、結果のない `tool_use` の `assistant` の行があるかを見る。続けて `working` → `done` の行を作り、`assistant` の `text` とターンの終わりの `system` の行があるかを見る。
- 違っていたら、節と ADR-0011 の「依存する範囲」を直し、`learning` の issue を起票する。

## 状態ごとの行を安く作る(2.1.281 で確認)
リポジトリ本体(信頼済みのディレクトリ)で起動する。`claude --bg --help` はヘルプを出さずにセッションを起動するので使わない。
- `blocked` + `idle`(プロンプトなし): `claude --bg --name probe-idle`。API を呼ばない。
- `failed`: `claude --bg --name probe-failed --model no-such-model-x "hi"`。API を呼ばない。プロンプトがないと最初のターンが来ないので `failed` にならず `blocked` のまま。
- `working` → `done`: `claude --bg --name probe-work --model haiku "Write a 300-word paragraph about tea. Do not use any tools."` を1秒おきに観測する。数秒で `done` になる。
- 権限待ち(`waitingFor: "permission prompt"`): `claude --bg --name probe-perm --model haiku "Run this exact bash command and nothing else: curl -sI https://example.com"`。断られるときは、cwd の外へ書く Bash を頼む(`"Use the Bash tool to run exactly: date > /private/tmp/claude-501/probe-perm-xyz.txt . Then report the result."`。約3秒、2.1.283)。
- 許可待ち(`waitingFor: "sandbox request"`): `--settings` に `{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false}}` を置いたファイルを渡し、`claude --bg --name probe-sbx --model haiku --settings sbx.json "Run the bash command 'curl -sI https://example.com' and tell me the result."`。数秒でこの状態になる(2.1.283)。
- `stopped` / 止めたあとの行: 上のものを `claude stop <id>` して数秒待つ。
- 対話セッション(`interactive`)の行: `claude --model haiku` を開き、長い文章を書かせて busy にするのが確実。権限待ちを作る指示は、対話セッションでは利用者の CLAUDE.md の下で断られることがある(同じ指示でも `--bg` では通った。2.1.283)。
- `--allowedTools` などの複数の値を取るオプションは、後ろに置いたプロンプトまで値として飲み込み、プロンプトなしで起動する。プロンプトは `--` の後ろに置く(`claude --bg --allowedTools Bash -- "<指示>"`)。
- 片付け: `claude stop <id>` のあと `claude rm <id>`。

## 見本を足すとき
- 実機の行をそのまま置かない。リポジトリは公開されている。`cwd` は `/home/user/repo`、`id`・`sessionId` は架空の値、`name` は `sample-<状態>` に置き換える。キーの並びと型は変えない。
- 見本に採れていないが公式ドキュメントや過去の実測で分かっている値は `otherKnownValues` に `"<kind>.<key>"` で足す。
