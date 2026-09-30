// n の作業ディレクトリの候補(表示名と絞り込み)
import {execFile} from 'node:child_process';
import {sep} from 'node:path';

export type Cand = {path: string; label: string};

// 末尾のディレクトリ名で表示し、同じ名前が複数あるときだけ区別できるところまで親を足す
export function labelsFor(paths: string[]): Cand[] {
	const parts = paths.map(p => p.split(sep).filter(Boolean));
	const depth = paths.map(() => 1);
	const label = (i: number) => parts[i]!.slice(-depth[i]!).join('/') || paths[i]!;
	for (let round = 0; round < 20; round++) {
		const groups = new Map<string, number[]>();
		paths.forEach((_, i) => {
			const l = label(i);
			groups.set(l, [...(groups.get(l) ?? []), i]);
		});
		let changed = false;
		for (const idx of groups.values()) {
			if (idx.length < 2) continue;
			for (const i of idx) {
				if (depth[i]! < parts[i]!.length) {
					depth[i]!++;
					changed = true;
				}
			}
		}
		if (!changed) break;
	}
	return paths.map((path, i) => ({path, label: label(i)}));
}

function subsequence(hay: string, needle: string): boolean {
	let j = 0;
	for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
	return j === needle.length;
}

// 表示名はとびとびの一致でも当たり、フルパスは続けて含むときだけ当たる。表示名の当たりを上に、連続の一致を上に。
export function filterCands<T extends {label: string; path?: string}>(cands: T[], query: string): T[] {
	const q = query.toLowerCase();
	if (!q) return cands;
	const scored: Array<{c: T; score: number; i: number}> = [];
	cands.forEach((c, i) => {
		const label = c.label.toLowerCase();
		if (subsequence(label, q)) scored.push({c, score: label.includes(q) ? 0 : 1, i});
		else if (c.path && c.path.toLowerCase().includes(q)) scored.push({c, score: 2, i});
	});
	return scored.sort((a, b) => a.score - b.score || a.i - b.i).map(x => x.c);
}

export function ghqList(): Promise<string[]> {
	return new Promise(resolve => {
		execFile('ghq', ['list', '-p'], {timeout: 5000, maxBuffer: 8 << 20}, (err, out) =>
			resolve(err ? [] : String(out).split('\n').filter(Boolean)),
		);
	});
}
