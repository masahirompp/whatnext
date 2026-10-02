---
name: releasing-whatnext
description: whatnext の版を上げて npm に公開するとき(npm version、npm publish、公開後の確かめ)に読む。AI と利用者の分担、版の付け方、上げすぎたときの戻し方、公開直後の見え方。
---

# whatnext のリリース

公開は取り消せない外部への操作なので、`npm publish` は利用者が行う(PRODUCT.md「配布」)。

- auto mode では、AI が `npm version` + `npm publish` を実行しようとすると、安全判定(公開物の作成)で拒否される。拒否されたコマンドは丸ごと実行されない(版も上がらない)。AI は `npm pack --dry-run` で同梱物を示して止まり、利用者が `! npm publish --access public` で公開する。
- 版の付け方(これまでの履歴の慣行): 機能の追加・廃止は minor、既存機能の動きの手直しは patch。`npm version <minor|patch>` はコミット「<版>」とタグ `v<版>` を作る。`git push origin main --follow-tags` で一緒に送る。
- 版を上げすぎたとき(`npm version minor` を2回打ったなど): publish・push の前なら、npm の最新版と origin のタグにその版が無いことを確かめてから、`git tag -d v<版>` と `git reset --hard <戻す先のコミット>` で戻せる。
- 公開の直後は、`npm view @masahirompp/whatnext version` や `--prefer-online` を付けた `versions` が、1つ前の版を最新として返すことがある(0.15.0 で約1分)。失敗と決めつけず、1〜2分待ってから `npx -y --prefer-online @masahirompp/whatnext@<版> --help` で起動できることを確かめる。
