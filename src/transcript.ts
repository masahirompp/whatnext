// 会話記録(~/.claude/projects/*/<sessionId>.jsonl)を読む。依存する項目は ADR-0011 の範囲に限る。
import {existsSync, readdirSync} from 'node:fs';
import {open, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

export type ToolUse = {name: string; input: unknown; ts: number};

export type TranscriptInfo = {
	mtimeMs: number;
	size: number;
	instruction?: {text: string; ts: number};
	// 最後の指示より後の行から取るもの
	lastText?: {text: string; ts: number};
	pendingTool?: ToolUse;
	ask?: {question: string; ts: number};
	declined?: ToolUse;
	apiError?: {text: string; ts: number};
	lastTs?: number;
	lastUserAssistantTs?: number;
};

const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

const paths = new Map<string, string>();
const cache = new Map<string, TranscriptInfo>();

function findPath(sid: string): string | undefined {
	const known = paths.get(sid);
	if (known && existsSync(known)) return known;
	try {
		const dir = projectsDir();
		for (const d of readdirSync(dir)) {
			const p = join(dir, d, `${sid}.jsonl`);
			if (existsSync(p)) {
				paths.set(sid, p);
				return p;
			}
		}
	} catch {
		// 置き場所がなければ補わない
	}
	return undefined;
}

async function readTail(path: string, size: number, bytes: number): Promise<string[]> {
	const fh = await open(path, 'r');
	try {
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		await fh.read(buf, 0, buf.length, start);
		const lines = buf.toString('utf8').split('\n');
		if (start > 0) lines.shift();
		return lines;
	} finally {
		await fh.close();
	}
}

type Line = {
	type?: string;
	subtype?: string;
	timestamp?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isApiErrorMessage?: boolean;
	message?: {id?: string; content?: unknown};
};

const tsOf = (l: Line) => (l.timestamp ? Date.parse(l.timestamp) : 0);

function isInstruction(l: Line): string | undefined {
	if (l.type !== 'user' || l.isSidechain || l.isMeta) return undefined;
	const c = l.message?.content;
	if (typeof c !== 'string') return undefined;
	// ターンを始めるスラッシュコマンド(スキルなど)は <command-message> で始まる。`/review 12` の形にする。
	// <command-name> で始まるもの(/model、/clear など)は手元で完結し、ターンを始めない
	if (/^\s*<command-message>/.test(c)) {
		const name = /<command-name>([^<]*)<\/command-name>/.exec(c)?.[1]?.trim();
		const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(c)?.[1]?.trim();
		return name ? [name, args].filter(Boolean).join(' ') : undefined;
	}
	if (/^\s*<(local-command|command-|system-reminder|bash-)/.test(c)) return undefined;
	return c;
}

function analyze(lines: Line[]): Omit<TranscriptInfo, 'mtimeMs' | 'size'> {
	const info: Omit<TranscriptInfo, 'mtimeMs' | 'size'> = {};
	let from = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const text = isInstruction(lines[i]!);
		if (text !== undefined) {
			info.instruction = {text, ts: tsOf(lines[i]!)};
			from = i + 1;
			break;
		}
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]!;
		if ((l.type === 'user' || l.type === 'assistant') && !l.isSidechain) {
			info.lastUserAssistantTs = tsOf(l);
			break;
		}
	}
	const uses = new Map<string, ToolUse>();
	const results = new Map<string, string>();
	let lastTextId: string | undefined;
	let texts: string[] = [];
	let textTs = 0;
	for (let i = from; i < lines.length; i++) {
		const l = lines[i]!;
		if (l.isSidechain) continue;
		if (l.type === 'user' || l.type === 'assistant' || (l.type === 'system' && (l.subtype === 'turn_duration' || l.subtype === 'stop_hook_summary'))) {
			info.lastTs = tsOf(l);
		}
		const content = l.message?.content;
		if (!Array.isArray(content)) continue;
		for (const part of content as Array<Record<string, unknown>>) {
			if (l.type === 'assistant' && part.type === 'text' && typeof part.text === 'string') {
				if (l.isApiErrorMessage) {
					info.apiError = {text: part.text, ts: tsOf(l)};
					continue;
				}
				const id = l.message?.id ?? String(i);
				if (id !== lastTextId) {
					lastTextId = id;
					texts = [];
				}
				texts.push(part.text);
				textTs = tsOf(l);
			}
			if (l.type === 'assistant' && part.type === 'tool_use') {
				uses.set(String(part.id), {name: String(part.name), input: part.input, ts: tsOf(l)});
			}
			if (l.type === 'user' && part.type === 'tool_result') {
				const c = part.content;
				const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x as {text?: string}).text ?? '').join('') : '';
				results.set(String(part.tool_use_id), text);
			}
		}
	}
	if (texts.length) info.lastText = {text: texts.join('\n'), ts: textTs};
	for (const [id, use] of uses) {
		const result = results.get(id);
		if (result === undefined) {
			if (use.name === 'AskUserQuestion') {
				const q = (use.input as {questions?: Array<{question?: string}>})?.questions?.[0]?.question;
				if (q) info.ask = {question: q, ts: use.ts};
			} else info.pendingTool = use;
		} else if (/doesn't want to proceed/.test(result)) {
			info.declined = use;
		}
	}
	return info;
}

// 更新時刻が変わったファイルだけを、末尾から必要な分だけ読む。読めなければ undefined(補わない)。
export async function readTranscript(sid: string): Promise<TranscriptInfo | undefined> {
	const path = findPath(sid);
	if (!path) return undefined;
	try {
		const st = await stat(path);
		const prev = cache.get(sid);
		if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev;
		const parse = (raw: string[]) =>
			raw.flatMap(s => {
				if (!s.trim()) return [];
				try {
					return [JSON.parse(s) as Line];
				} catch {
					return [];
				}
			});
		let lines = parse(await readTail(path, st.size, 1 << 20));
		let info = analyze(lines);
		if (!info.instruction && st.size > 1 << 20) {
			lines = parse(await readTail(path, st.size, 32 << 20));
			info = analyze(lines);
		}
		const out = {...info, mtimeMs: st.mtimeMs, size: st.size};
		cache.set(sid, out);
		return out;
	} catch {
		return undefined;
	}
}
