// External commands: claude, git, gh, ghq, open.
import {execFile, spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type {RawRow} from './model.js';

export type Run = {code: number; stdout: string; stderr: string};

export function run(
	cmd: string,
	args: string[],
	opts: {cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv} = {},
): Promise<Run> {
	return new Promise(resolve => {
		const child = execFile(
			cmd,
			args,
			{cwd: opts.cwd, timeout: opts.timeout ?? 30000, maxBuffer: 32 * 1024 * 1024, env: opts.env},
			(err, stdout, stderr) => {
				const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 127) : 0;
				resolve({code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : ''))});
			},
		);
		child.stdin?.end();
	});
}

export async function readAgents(): Promise<RawRow[]> {
	const r = await run('claude', ['agents', '--json', '--all']);
	if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `claude agents exited with ${r.code}`);
	let data: unknown;
	try {
		data = JSON.parse(r.stdout);
	} catch {
		throw new Error('Could not parse the output of `claude agents --json`.');
	}
	if (!Array.isArray(data)) throw new Error('Unexpected output of `claude agents --json`.');
	return data as RawRow[];
}

// --- where -------------------------------------------------------------

export type Where = {
	repo: string;
	branch?: string; // only when not default
	worktree: boolean;
	checkoutRoot: string;
	repoRoot: string;
	pr?: {number: number; state: 'open' | 'draft' | 'merged' | 'closed'; url: string};
};

const defaultBranchCache = new Map<string, string | null>();

async function defaultBranch(repoRoot: string): Promise<string | null> {
	if (defaultBranchCache.has(repoRoot)) return defaultBranchCache.get(repoRoot)!;
	const r = await run('git', ['-C', repoRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
	let b: string | null = null;
	if (r.code === 0) b = r.stdout.trim().replace(/^origin\//, '');
	defaultBranchCache.set(repoRoot, b);
	return b;
}

export async function gitWhere(cwd: string): Promise<Where> {
	const fallback: Where = {repo: path.basename(cwd) || cwd, worktree: false, checkoutRoot: cwd, repoRoot: cwd};
	const r = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir', '--abbrev-ref', 'HEAD']);
	if (r.code !== 0) return fallback;
	const [top, common0, gitDir0, branch] = r.stdout.trim().split('\n');
	if (!top || !common0 || !gitDir0) return fallback;
	const common = path.resolve(cwd, common0);
	const gitDir = path.resolve(cwd, gitDir0);
	const worktree = common !== gitDir;
	const repoRoot = path.basename(common) === '.git' ? path.dirname(common) : top;
	let repo = path.basename(repoRoot);
	const rel = path.relative(top, cwd);
	if (rel && !rel.startsWith('..')) repo = `${repo}/${rel}`;
	const def = await defaultBranch(repoRoot);
	const isDefault = branch === def || (!def && (branch === 'main' || branch === 'master'));
	return {
		repo,
		branch: branch && branch !== 'HEAD' && !isDefault ? branch : undefined,
		worktree,
		checkoutRoot: top,
		repoRoot,
	};
}

let ghOk: boolean | null = null;
export async function prFor(where: Where, rawBranch?: string): Promise<Where['pr']> {
	const branch = rawBranch ?? where.branch;
	if (!branch) return undefined;
	if (ghOk === false) return undefined;
	const r = await run(
		'gh',
		['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state,isDraft,url'],
		{cwd: where.checkoutRoot, timeout: 15000},
	);
	if (r.code === 127) ghOk = false;
	if (r.code !== 0) return undefined;
	try {
		const [p] = JSON.parse(r.stdout);
		if (!p) return undefined;
		const st = String(p.state).toLowerCase();
		const state = p.isDraft && st === 'open' ? 'draft' : (st as 'open' | 'merged' | 'closed');
		return {number: p.number, state, url: p.url};
	} catch {
		return undefined;
	}
}

// --- usage -------------------------------------------------------------

export type UsageItem = {label: string; percent: number; resets: string};

export async function readUsage(): Promise<UsageItem[] | null> {
	try {
		const r = await run('claude', ['-p', '/usage', '--no-session-persistence', '--output-format', 'json'], {cwd: os.tmpdir(), timeout: 30000});
		if (r.code !== 0) return null;
		const text = String(JSON.parse(r.stdout).result ?? '');
		return parseUsage(text);
	} catch {
		return null;
	}
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseUsage(text: string, now = new Date()): UsageItem[] | null {
	const out: UsageItem[] = [];
	const re = /Current ([^:\n]+):\s*(\d+)% used(?:\s*·\s*resets\s+([^\n]+))?/g;
	for (const m of text.matchAll(re)) {
		let resets = (m[3] ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
		const today = `${MONTHS[now.getMonth()]} ${now.getDate()} at `;
		if (resets.startsWith(today)) resets = resets.slice(today.length);
		resets = resets.replace(' at ', ' ');
		out.push({label: m[1]!.trim(), percent: Number(m[2]), resets});
	}
	return out.length ? out : null;
}

// --- dirs --------------------------------------------------------------

export async function ghqList(): Promise<string[]> {
	const r = await run('ghq', ['list', '-p'], {timeout: 10000});
	if (r.code !== 0) return [];
	return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

export function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function expandHome(p: string): string {
	if (p === '~') return os.homedir();
	if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
	return p;
}

export function openExternal(target: string): Promise<Run> {
	const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
	return run(cmd, [target], {timeout: 10000});
}

export function spawnDetached(cmd: string, args: string[]) {
	const c = spawn(cmd, args, {stdio: 'ignore', detached: true});
	c.unref();
}
