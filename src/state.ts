// 保留と待ち先の関係を、起動し直しても引き継ぐためのファイル(ADR-0016)。
// ${XDG_STATE_HOME:-~/.local/state}/whatnext/state.json。専用の tmux サーバを分けて動かすとき(WHATNEXT_TMUX_SOCKET)は、ファイルも分ける
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {SOCKET} from './env.js';
import type {Waits} from './model.js';

const DIR = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'whatnext');
const FILE = join(DIR, SOCKET === 'whatnext' ? 'state.json' : `state-${SOCKET}.json`);

type Saved = {version: 1; holds: Record<string, string>; waits: Record<string, string[]>};

const serialize = (holds: Map<string, string>, waits: Waits): string =>
	JSON.stringify(
		{
			version: 1,
			holds: Object.fromEntries(holds),
			waits: Object.fromEntries([...waits].filter(([, cs]) => cs.size > 0).map(([p, cs]) => [p, [...cs]])),
		} satisfies Saved,
		null,
		'\t',
	) + '\n';

let last: string | undefined;

// 読めない(ない、壊れている、版が違う)ときは空で始める
export function loadState(): {holds: Map<string, string>; waits: Waits} {
	try {
		const text = readFileSync(FILE, 'utf8');
		const s = JSON.parse(text) as Partial<Saved>;
		if (s.version !== 1) return {holds: new Map(), waits: new Map()};
		const holds = new Map(Object.entries(s.holds ?? {}).filter(([, r]) => typeof r === 'string'));
		const waits: Waits = new Map(Object.entries(s.waits ?? {}).map(([p, cs]) => [p, new Set(Array.isArray(cs) ? cs.filter(c => typeof c === 'string') : [])]));
		last = serialize(holds, waits);
		return {holds, waits};
	} catch {
		return {holds: new Map(), waits: new Map()};
	}
}

// 変わったときだけ書く。一時ファイルに書いてから置き換え、書きかけのファイルを残さない。書けなくても一覧は止めない
export function saveState(holds: Map<string, string>, waits: Waits): void {
	const text = serialize(holds, waits);
	if (text === last) return;
	try {
		mkdirSync(DIR, {recursive: true});
		const tmp = `${FILE}.${process.pid}.tmp`;
		writeFileSync(tmp, text);
		renameSync(tmp, FILE);
		last = text;
	} catch {
		// 次に変わったときにまた試す
	}
}
