// Reads Claude Code's per-session transcripts (~/.claude/projects/*/<sessionId>.jsonl)
// to fill in what hooks could not give (ADR-0011). Read-only; results live in memory.
// Depends only on: row `type` (user / assistant), `timestamp`, `message.content`
// (user string, assistant text / tool_use, tool_result) and `isApiErrorMessage`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type TranscriptInfo = {
	/** the last instruction (a user row whose content is a string) */
	prompt?: {at: number; text: string};
	/** the last assistant text after the prompt, when no tool_use follows it (the turn's answer) */
	answer?: {at: number; text: string};
	/** the last assistant text after the prompt, even if a tool_use follows (an interrupted turn) */
	lastText?: {at: number; text: string};
	/** a tool_use after the prompt without its tool_result yet */
	pendingTool?: {at: number; tool: string; input: any};
	/** an API error row after the prompt */
	error?: {at: number; text: string};
	/** timestamp of the last user / assistant row */
	lastAt?: number;
	/** identity of the last user / assistant row, to tell whether rows were added */
	lastKey?: string;
};

function projectsDir(): string {
	const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
	return path.join(base, 'projects');
}

const pathCache = new Map<string, string>();

export function findTranscript(sessionId: string): string | undefined {
	const cached = pathCache.get(sessionId);
	if (cached && fs.existsSync(cached)) return cached;
	const root = projectsDir();
	let dirs: string[];
	try {
		dirs = fs.readdirSync(root);
	} catch {
		return undefined;
	}
	for (const d of dirs) {
		const p = path.join(root, d, `${sessionId}.jsonl`);
		if (fs.existsSync(p)) {
			pathCache.set(sessionId, p);
			return p;
		}
	}
	return undefined;
}

const isPromptText = (s: string) => !/^<(local-command-|bash-)/.test(s);

/** `<command-name>/foo</command-name> … <command-args>x</command-args>` → `/foo x` */
export function cleanPrompt(s: string): string {
	const name = s.match(/<command-name>([^<]*)<\/command-name>/)?.[1];
	if (!name) return s;
	const args = s.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
	return args ? `${name} ${args}` : name;
}

/**
 * Summarize the rows after the last instruction. `lines` are JSONL lines in file
 * order; only the tail is needed as long as it contains the last instruction
 * (`sawPrompt` tells whether it did).
 */
export function summarize(lines: string[]): {info: TranscriptInfo; sawPrompt: boolean} {
	const rows: any[] = [];
	for (const l of lines) {
		if (!l) continue;
		try {
			const o = JSON.parse(l);
			if (o && (o.type === 'user' || o.type === 'assistant') && !o.isSidechain) rows.push(o);
		} catch {}
	}
	const info: TranscriptInfo = {};
	const ts = (o: any) => {
		const t = Date.parse(o.timestamp);
		return Number.isFinite(t) ? t : undefined;
	};
	const last = rows[rows.length - 1];
	if (last) {
		info.lastAt = ts(last);
		info.lastKey = String(last.uuid ?? `${last.type}@${last.timestamp}`);
	}
	let start = 0;
	let sawPrompt = false;
	for (let i = rows.length - 1; i >= 0; i--) {
		const o = rows[i];
		const c = o.message?.content;
		if (o.type === 'user' && typeof c === 'string' && !o.isMeta && !o.isCompactSummary && isPromptText(c)) {
			const at = ts(o);
			if (at != null) info.prompt = {at, text: cleanPrompt(c)};
			start = i + 1;
			sawPrompt = true;
			break;
		}
	}
	const pending = new Map<string, {at: number; tool: string; input: any}>();
	type Parts = {id: string; at: number; texts: string[]};
	let answerParts: Parts | null = null;
	let lastParts: Parts | null = null;
	for (let i = start; i < rows.length; i++) {
		const o = rows[i];
		const at = ts(o) ?? 0;
		const c = o.message?.content;
		if (o.type === 'user') {
			if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool_result') pending.delete(String(b.tool_use_id));
			continue;
		}
		if (!Array.isArray(c)) continue;
		if (o.isApiErrorMessage) {
			const text = c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text)).join('\n');
			info.error = {at, text};
			continue;
		}
		const mid = String(o.message?.id ?? o.uuid ?? i);
		for (const b of c) {
			if (b?.type === 'tool_use') {
				pending.set(String(b.id), {at, tool: String(b.name ?? '?'), input: b.input});
				answerParts = null;
			} else if (b?.type === 'text' && typeof b.text === 'string') {
				if (!answerParts || answerParts.id !== mid) answerParts = {id: mid, at, texts: []};
				answerParts.texts.push(b.text);
				answerParts.at = at;
				lastParts = answerParts;
			}
		}
	}
	if (answerParts) info.answer = {at: answerParts.at, text: answerParts.texts.join('\n')};
	if (lastParts) info.lastText = {at: lastParts.at, text: lastParts.texts.join('\n')};
	const pend = [...pending.values()].pop();
	if (pend) info.pendingTool = pend;
	return {info, sawPrompt};
}

type Cached = {mtimeMs: number; size: number; info: TranscriptInfo};
const cache = new Map<string, Cached>();

const CHUNKS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];

function readTail(file: string, size: number, bytes: number): {lines: string[]; whole: boolean} {
	const fd = fs.openSync(file, 'r');
	try {
		const n = Math.min(size, bytes);
		const buf = Buffer.alloc(n);
		fs.readSync(fd, buf, 0, n, size - n);
		const lines = buf.toString('utf8').split('\n');
		const whole = n === size;
		if (!whole) lines.shift(); // partial first line
		return {lines, whole};
	} finally {
		fs.closeSync(fd);
	}
}

/** Read (or reuse) the summary of a session's transcript. undefined when there is none. */
export function readTranscript(sessionId: string): TranscriptInfo | undefined {
	try {
		const file = findTranscript(sessionId);
		if (!file) return undefined;
		const stat = fs.statSync(file);
		const c = cache.get(sessionId);
		if (c && c.mtimeMs === stat.mtimeMs && c.size === stat.size) return c.info;
		let info: TranscriptInfo = {};
		for (const bytes of CHUNKS) {
			const {lines, whole} = readTail(file, stat.size, bytes);
			const r = summarize(lines);
			info = r.info;
			if (r.sawPrompt || whole) break;
		}
		cache.set(sessionId, {mtimeMs: stat.mtimeMs, size: stat.size, info});
		return info;
	} catch {
		return undefined;
	}
}
