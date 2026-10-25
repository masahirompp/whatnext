import {existsSync, realpathSync} from 'node:fs';
import {dirname, relative} from 'node:path';
import type {Run} from '../../lib/input/exec.js';

// 場所の問い合わせ(`git` と `gh`)。PRODUCT.md「一覧の表示」の WHERE、「リポジトリの区切りと並び」の区切りの単位。

export interface Location {
  /** 区切りの根(元のリポジトリの根。git でない場所は cwd そのもの)。 */
  root: string;
  repo: boolean;
  /** チェックアウトの根(worktree ならその worktree。VS Code で開く場所)。 */
  checkout: string;
  /** 根より下のパス(submodule のパスを含む)。 */
  sub?: string;
  /** 既定でないブランチ。 */
  branch?: string;
  /** PR を引くブランチ(既定のブランチでも持つ)。 */
  head?: string;
  worktree: boolean;
}

const lines = (s: string) => s.split('\n').map(l => l.trim());

/** `cwd` の場所を1回問い合わせる。git でない、または問い合わせに失敗したら、リポジトリでない場所として返す。 */
export async function locate(run: Run, cwd: string): Promise<Location> {
  // git でない場所はパスごとに区切る。同じ場所を別の書き方(`/tmp` と `/private/tmp`)で分けないよう、実パスにする
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {}
  const plain: Location = {root: real, repo: false, checkout: cwd, worktree: false};
  const g = (args: string[], dir = cwd) => run('git', ['-C', dir, ...args], {timeout: 10000});
  const top = await g(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir']);
  if (top.code !== 0) return plain;
  const [toplevel, commonDir, gitDir] = lines(top.stdout);
  if (!toplevel || !commonDir || !gitDir) return plain;
  const [superR, head, originHead] = await Promise.all([
    g(['rev-parse', '--show-superproject-working-tree']),
    g(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    g(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
  ]);
  const branch = head.code === 0 ? head.stdout.trim() : undefined;
  const def = originHead.code === 0 ? originHead.stdout.trim().replace(/^origin\//, '') : undefined;
  const isDefault = branch !== undefined && (def ? branch === def : branch === 'main' || branch === 'master');
  const worktree = gitDir !== commonDir;
  // 根は共有の git ディレクトリの親(`.git` ならリポジトリの根、`.bare` 型なら裸のリポジトリの親)
  let root = dirname(commonDir);
  let base = toplevel;
  const superproject = superR.code === 0 ? superR.stdout.trim() : '';
  if (superproject) {
    // submodule は親のリポジトリの区切りに入る(親の根まで上る)
    const parent = await locate(run, superproject);
    if (parent.repo) {
      root = parent.root;
      base = superproject;
    }
  }
  const rel = relative(base, real);
  const subFromBase = rel && !rel.startsWith('..') ? rel : undefined;
  // worktree は自分のチェックアウトの根からのパス、submodule は親のチェックアウトの根からのパス
  return {
    root,
    repo: true,
    checkout: toplevel,
    sub: subFromBase,
    branch: branch && !isDefault ? branch : undefined,
    head: branch,
    worktree,
  };
}

/**
 * 場所を覚えておく。前回リポジトリだった場所がリポジトリでない場所として返ったときは、1回だけ前回の場所を使う
 * (DESIGN.md「場所の問い合わせ」の「失敗したとき」)。
 */
export class Locations {
  private known = new Map<string, Location>();
  private misses = new Map<string, number>();
  constructor(private readonly run: Run) {}

  get(cwd: string): Location | undefined {
    return this.known.get(cwd);
  }

  async refresh(cwds: readonly string[]): Promise<void> {
    const uniq = [...new Set(cwds)];
    const got = await Promise.all(uniq.map(c => locate(this.run, c)));
    uniq.forEach((c, i) => {
      const loc = got[i];
      const before = this.known.get(c);
      if (!loc.repo && before?.repo && (this.misses.get(c) ?? 0) === 0) {
        this.misses.set(c, 1);
        return;
      }
      this.misses.delete(c);
      this.known.set(c, loc);
    });
    for (const c of [...this.known.keys()]) if (!uniq.includes(c)) this.known.delete(c);
  }
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export interface Pr {
  number: number;
  state: PrState;
}

/** `gh` でブランチを head に持つ最新の PR を引く。`gh` がない、認証していないときは使えないと覚える。 */
export class Prs {
  private cache = new Map<string, {pr?: Pr; at: number}>();
  private inflight = new Set<string>();
  private unavailable = false;
  private authOk: boolean | undefined;
  constructor(
    private readonly run: Run,
    private readonly now: () => number = Date.now,
  ) {}

  get(checkout: string, branch: string): Pr | undefined {
    return this.cache.get(`${checkout}\0${branch}`)?.pr;
  }

  /** 古いものを引き直す。分かったら onChange を呼ぶ。待たせない。 */
  refresh(items: readonly {checkout: string; branch: string}[], onChange: () => void, maxAge = 60_000): void {
    if (this.unavailable) return;
    for (const {checkout, branch} of items) {
      const key = `${checkout}\0${branch}`;
      const c = this.cache.get(key);
      if (this.inflight.has(key) || (c && this.now() - c.at < maxAge)) continue;
      this.inflight.add(key);
      // 引き始めた時刻で数える。失敗したときも時刻だけは進め、前の値を残す(60秒に1回までを守る)
      const started = this.now();
      void this.fetch(checkout, branch).then(pr => {
        this.inflight.delete(key);
        const before = this.cache.get(key)?.pr;
        if (pr === null) {
          this.cache.set(key, {pr: before, at: started});
          return;
        }
        this.cache.set(key, {pr, at: started});
        if (before?.number !== pr?.number || before?.state !== pr?.state) onChange();
      });
    }
  }

  private async fetch(checkout: string, branch: string): Promise<Pr | undefined | null> {
    const r = await this.run(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state,isDraft'],
      {cwd: checkout, timeout: 20000},
    );
    if (r.code === null) {
      // gh がないと覚えるのは、起動できず(ENOENT)、しかもチェックアウトの場所がまだあるときだけ。
      // タイムアウトや、消えた worktree で起動できなかったときは、一時的な失敗として次の回に引き直す
      if (r.error === 'ENOENT' && existsSync(checkout)) this.unavailable = true;
      return null;
    }
    if (r.code !== 0) {
      // 文言に auth や login が出ても、remote が GitHub でないリポジトリのこともある。
      // 認証していないかは gh auth status で一度だけ確かめ、そうでなければこのリポジトリだけの失敗として扱う
      if (/auth|login/i.test(r.stderr) && this.authOk === undefined) {
        const a = await this.run('gh', ['auth', 'status'], {timeout: 20000});
        if (a.code !== null) this.authOk = a.code === 0;
        if (this.authOk === false) this.unavailable = true;
      }
      return null;
    }
    try {
      const j = JSON.parse(r.stdout) as {number: number; state: string; isDraft?: boolean}[];
      const p = j[0];
      if (!p) return undefined;
      const s = p.state.toLowerCase();
      const state: PrState = s === 'open' ? (p.isDraft ? 'draft' : 'open') : s === 'merged' ? 'merged' : 'closed';
      return {number: p.number, state};
    } catch {
      return null;
    }
  }
}
