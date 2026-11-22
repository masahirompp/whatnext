---
name: releasing-whatnext
description: whatnext の版を上げて npm に公開するとき(版を上げる PR、タグ v<版> の push、CI が npm の stage に置いた版の確かめと承認、公開後の確かめ)に読む。AI と利用者の分担、版の付け方、上げすぎたときの戻し方、初回だけの trusted publisher の登録、公開直後の見え方。
---

# whatnext のリリース

公開は取り消せない外部への操作なので、最後の一押し(npm の stage の承認、2FA 付き)は利用者が行う(PRODUCT.md「配布」)。
CI(`.github/workflows/publish.yml`)は、タグ `v<版>` の push で起動し、trusted publisher(OIDC)で `npm stage publish` する。
CI にも手元にも、公開に使うトークンは置かない。

## 流れと分担

1. **AI: 版を上げる PR を作る。** `npm version <minor|patch> --no-git-tag-version` で `package.json` と `package-lock.json` の版を上げ、コミット「<版>」にして PR を出す。タグはまだ作らない。
2. **利用者: PR をマージする。**
3. **AI: 利用者の確認を得てから、タグを付けて送る。** `git fetch origin` のあと、main のマージのコミットに付ける。

   ```sh
   git tag v<版> <マージのコミット>
   git push origin v<版>
   ```

   `git push origin main --follow-tags` は使わない(main への変更は PR を通す)。
4. **CI: 判定のあと stage に置く。** タグのコミットが main のマージのコミット(`origin/main` の first-parent の鎖の上)であること、タグの版が `package.json` の `version` と一致することを確かめ、外れたら止まる。通れば `npm ci`、build、check、test のあと `npm stage publish --access public` する。
5. **AI: stage に置いた中身を示す。** `npm stage` の操作(`list`、`download`、`approve`、`reject`)はどれも npm 11.15.0 以上が要る。手元の npm が古ければ、`npx -y npm@11 stage list @masahirompp/whatnext` のように、npm を指定して流す。`npm stage list @masahirompp/whatnext` で stage の id を引き、`npm stage download <id>` の tarball と、同じタグから手元で作った tarball を比べて示す。

   ```sh
   git worktree add --detach /tmp/whatnext-v<版> v<版>
   mkdir -p /tmp/whatnext-pack-v<版>
   cd /tmp/whatnext-v<版> && npm ci && npm pack --pack-destination /tmp/whatnext-pack-v<版>   # prepack が build する
   # 2つの tarball を別々のディレクトリに展開して diff -r で比べる。済んだら git worktree remove で消す
   # (tarball を worktree の外に置くので、worktree に追跡していないファイルが残らず、remove が断られない)
   ```
6. **利用者: 中身を確かめて承認する。** `npm stage approve <id>` か、npmjs.com のパッケージの Staged Packages で承認する。どちらも 2FA を求められる(npm の docs)。承認すると公開される。

## 版の付け方

これまでの履歴の慣行: 機能の追加・廃止は minor、既存機能の動きの手直しは patch。

## 上げすぎたとき、止めたいとき

- **タグを push する前**: 版を上げる PR を閉じるか、PR の中で版を直すだけでよい。マージのあとなら、版を直す PR を出す。npm にも origin のタグにもその版はまだ無い。
- **タグを push したが CI が stage に置く前に止まった**(判定、build、check、test のどれか): stage には何も置かれていない。原因(main のマージのコミットでないコミットに付けた、版を間違えた、main が壊れていた)を直したら、origin と手元の両方のタグを消してから付け直す。

  ```sh
  git push origin :refs/tags/v<版>
  git tag -d v<版>
  ```
- **stage に置いたあとで出したくなくなった**: `npm stage reject <id>`(2FA)で消し、patch を上げ直した版で出し直す。npm の docs では、stage を reject した版は同じ版の番号で置き直せる(タグの付け替えのために「reject してから置き直す」と書かれている)。ただ、同じ版の番号で出し直すには git のタグ `v<版>` を別のコミットへ付け替えることになり、タグと公開物の対応がたどりにくくなるので、版を上げ直す。

## 公開後の確かめ

- 公開の直後は、`npm view @masahirompp/whatnext version` や `--prefer-online` を付けた `versions` が、1つ前の版を最新として返すことがある(0.15.0 で約1分)。失敗と決めつけず、1〜2分待ってから確かめる。0.20.0 では、`npm view @masahirompp/whatnext@0.20.0 version --prefer-online` が版を返すまで約2分かかり、その間 `npx -y --prefer-online @masahirompp/whatnext@0.20.0` は `ETARGET` で失敗した(#302)。
- `npm view @masahirompp/whatnext@<版> gitHead` が、`git rev-parse v<版>^{commit}` と一致する。
- `npm view @masahirompp/whatnext@<版> dist.attestations` が `provenance`(`predicateType` が `https://slsa.dev/provenance/v1`)を返す。返さなければ、CI の trusted publisher を通らずに公開された疑いがある。
- `npx -y --prefer-online @masahirompp/whatnext@<版> --help` で起動できる。

## 初回だけの段取り(人の作業)

1. npmjs.com の `@masahirompp/whatnext` の設定で trusted publisher を登録する。GitHub Actions、リポジトリ `masahirompp/whatnext`、workflow のファイル名 `publish.yml`、environment は空、許す操作は `npm stage publish` だけ。
2. 登録から2日以内に最初の公開(タグの push から承認まで)を済ませる。済ませないと登録が切れ、使うことも直すこともできなくなる(npm の docs)。
3. 公開できたら、パッケージの公開の設定を「2FA を求め、トークンを許さない」(Require two-factor authentication and disallow tokens)にし、使わなくなった npm のトークンを消す。この設定は従来のトークンだけに効き、trusted publisher は使い続けられる(npm の docs)。

## 非常手段

- CI が壊れて直せないときだけ、利用者が手元から `npm publish --access public` で公開する。パッケージを「2FA を求め、トークンを許さない」にしたあとも手元から公開できるかは未確認。`EOTP` で止まったら、ブラウザの認証か `--otp=<コード>` で流し直す(#302)。
