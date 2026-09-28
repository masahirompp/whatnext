import {execFile} from 'node:child_process';

export type AgentRow = {
	kind: string;
	sessionId: string;
	id?: string;
	cwd: string;
	name?: string;
	startedAt?: number;
	pid?: number;
	state?: string;
	status?: string;
	waitingFor?: string;
};

export type Tier = 'permission' | 'question' | 'sandbox' | 'failed' | 'review' | 'working' | 'waiting';

export const TIER_ORDER: Tier[] = ['permission', 'question', 'sandbox', 'failed', 'review', 'working', 'waiting'];

export const TIER_LABEL: Record<Tier, string> = {
	permission: 'Permission',
	question: 'Question',
	sandbox: 'Sandbox',
	failed: 'Failed',
	review: 'Review',
	working: 'Working',
	waiting: 'Waiting',
};

export type Classified = {tier: Tier; reason?: string};

// 優先度ラダー(PRODUCT.md「--json の行から段を決める規則」)。null は対象外。
export function classify(row: AgentRow): Classified | null {
	const w = row.waitingFor;
	if (w === 'permission prompt') return {tier: 'permission'};
	if (w === 'input needed') return {tier: 'question'};
	if (w === 'sandbox request') return {tier: 'sandbox'};
	if (w) return {tier: 'question', reason: w};

	if (row.kind === 'interactive') {
		if (row.status === 'idle') return null;
		if (row.status === 'busy') return {tier: 'working'};
		return {tier: 'question', reason: row.status ?? 'unknown'};
	}

	const state = row.state;
	if (state === 'stopped') return null;
	if (state === 'failed') return {tier: 'failed'};
	if (state === 'blocked' && row.pid === undefined) return {tier: 'failed', reason: 'no process'};
	if (state === 'done') return {tier: 'review'};
	if (state === 'working' && row.status === 'idle') return {tier: 'question'};
	if (row.status === 'busy') return {tier: 'working'};
	if (state === 'working') return {tier: 'working'};
	if (row.status === 'waiting') return {tier: 'question', reason: 'waiting'};
	return {tier: 'question', reason: state ?? row.status ?? 'unknown'};
}

// 同じ sessionId の重複は、pid を持つ行を採る。どちらもなければ background の行。
export function dedupe(rows: AgentRow[]): AgentRow[] {
	const by = new Map<string, AgentRow>();
	for (const row of rows) {
		const prev = by.get(row.sessionId);
		if (!prev) {
			by.set(row.sessionId, row);
			continue;
		}
		const score = (r: AgentRow) => (r.pid !== undefined ? 2 : 0) + (r.kind === 'background' ? 1 : 0);
		if (score(row) > score(prev)) by.set(row.sessionId, row);
	}
	return [...by.values()];
}

export const displayName = (row: AgentRow) => row.name ?? row.id ?? row.sessionId.slice(0, 8);

export function fetchAgents(): Promise<AgentRow[]> {
	return new Promise((resolve, reject) => {
		execFile('claude', ['agents', '--json', '--all'], {timeout: 20000, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
			if (error) {
				const msg = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'claude was not found in PATH' : (String(stderr).trim() || error.message);
				reject(new Error(msg));
				return;
			}
			try {
				const parsed = JSON.parse(String(stdout));
				if (!Array.isArray(parsed)) throw new Error('not an array');
				resolve(parsed as AgentRow[]);
			} catch (e) {
				reject(new Error(`could not parse claude agents --json output (${(e as Error).message})`));
			}
		});
	});
}
