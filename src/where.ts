// WHERE の列(リポジトリ、既定でないブランチ、worktree、PR)。git は必須、gh は任意。
import {execFile} from 'node:child_process';
import {basename, dirname, relative} from 'node:path';

export type Pr = {number: number; state: 'open' | 'draft' | 'merged' | 'closed'; url: string};

export type Where = {
	repo: string; // 表示名(repo、repo/sub、パスの末尾)
	repoRoot?: string; // 元のリポジトリの根(worktree なら寄せたもの)
	checkoutRoot?: string; // cwd が属するチェックアウトの根
	branch?: string; // 既定でないときだけ
	rawBranch?: string;
	worktree: boolean;
	pr?: Pr;
};

const run = (cmd: string, args: string[], cwd: string, timeout = 5000) =>
	new Promise<string | undefined>(resolve => {
		execFile(cmd, args, {cwd, timeout, env: {...process.env, GH_PROMPT_DISABLED: '1'}}, (err, stdout) =>
			resolve(err ? undefined : String(stdout).trim()),
		);
	});

const gitCache = new Map<string, Promise<Where>>();

export function gitWhere(cwd: string, fresh = false): Promise<Where> {
	const hit = gitCache.get(cwd);
	if (hit && !fresh) return hit;
	const p = (async (): Promise<Where> => {
		const out = await run('git', ['rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'], cwd);
		if (!out) return {repo: basename(cwd) || cwd, worktree: false};
		const [top = cwd, commonRaw = '.git', branch = ''] = out.split('\n');
		const common = commonRaw.startsWith('/') ? commonRaw : `${top}/${commonRaw}`;
		const mainRoot = basename(common) === '.git' ? dirname(common) : top;
		const worktree = mainRoot !== top;
		const sub = relative(top, cwd);
		let repo = basename(mainRoot);
		if (sub && !sub.startsWith('..')) repo = `${repo}/${sub}`;
		let def = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
		def = def?.replace(/^origin\//, '');
		const isDefault = def ? branch === def : branch === 'main' || branch === 'master';
		return {
			repo,
			repoRoot: mainRoot,
			checkoutRoot: top,
			branch: branch && branch !== 'HEAD' && !isDefault ? branch : undefined,
			rawBranch: branch,
			worktree,
		};
	})();
	gitCache.set(cwd, p);
	return p;
}

let ghAvailable: boolean | undefined;

export async function fetchPr(cwd: string, branch: string): Promise<Pr | undefined> {
	if (ghAvailable === false) return undefined;
	const out = await run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state,isDraft,url'], cwd, 15000);
	if (out === undefined) {
		if (ghAvailable === undefined) ghAvailable = (await run('gh', ['auth', 'status'], cwd)) !== undefined;
		return undefined;
	}
	ghAvailable = true;
	try {
		const [pr] = JSON.parse(out) as Array<{number: number; state: string; isDraft: boolean; url: string}>;
		if (!pr) return undefined;
		const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open';
		return {number: pr.number, state, url: pr.url};
	} catch {
		return undefined;
	}
}

// n の作業ディレクトリの候補のために、worktree のパスを元のリポジトリの根に寄せる
export async function mainRepoOf(cwd: string): Promise<string> {
	const w = await gitWhere(cwd);
	return w.repoRoot ?? cwd;
}
