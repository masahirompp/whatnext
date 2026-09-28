// アカウントの Usage(`claude -p "/usage"`)。モデルを呼ばない。
import {execFile} from 'node:child_process';
import {tmpdir} from 'node:os';

export type UsageItem = {label: string; percent: number; resets?: string};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// `Current session: 1% used · resets Sep 25 at 2:09pm (Asia/Tokyo)`
export function parseUsage(text: string, now = new Date()): UsageItem[] {
	const items: UsageItem[] = [];
	const today = `${MONTHS[now.getMonth()]} ${now.getDate()}`;
	for (const line of text.split('\n')) {
		const m = /Current ([^:]+):\s*(\d+)% used(?:\s*·\s*resets\s+(.+?))?\s*$/.exec(line.trim());
		if (!m) continue;
		let resets = m[3]?.replace(/\s*\([^)]*\)\s*$/, '');
		if (resets) {
			const r = /^(\w{3} \d{1,2})(?: at)? (.+)$/.exec(resets);
			if (r) resets = r[1] === today ? r[2]! : `${r[1]} ${r[2]}`;
		}
		items.push({label: m[1]!.trim(), percent: Number(m[2]), resets});
	}
	return items;
}

export function fetchUsage(): Promise<UsageItem[] | undefined> {
	return new Promise(resolve => {
		const child = execFile(
			'claude',
			['-p', '/usage', '--no-session-persistence', '--output-format', 'json'],
			{cwd: tmpdir(), timeout: 30000},
			(err, stdout) => {
				if (err) return resolve(undefined);
				try {
					const r = JSON.parse(String(stdout)) as {result?: string};
					const items = parseUsage(r.result ?? '');
					resolve(items.length ? items : undefined);
				} catch {
					resolve(undefined);
				}
			},
		);
		child.stdin?.end();
	});
}
