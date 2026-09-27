// What a row says about the session right now (the note, since when it has been in
// its tier, the `!` commands), from hooks first and the transcript where hooks have
// nothing for the current turn. Pure; no I/O.
import {bangCommands, headLine, type Tier} from './model.js';
import type {SessionEvents} from './receiver.js';
import type {TranscriptInfo} from './transcript.js';

/** Hook and transcript timestamps of the same instruction differ by a few ms. */
const SAME_PROMPT_MS = 3000;

export type RowStatus = {note?: string; since?: number; bang: string[]};

const firstLine = (s: string) => s.split('\n').map(x => x.trim()).find(Boolean) ?? '';

export function describeTool(input: any): string {
	if (!input || typeof input !== 'object') return '';
	if (typeof input.command === 'string') return input.command;
	if (typeof input.file_path === 'string') return input.file_path;
	if (typeof input.notebook_path === 'string') return input.notebook_path;
	if (typeof input.url === 'string') return input.url;
	if (typeof input.pattern === 'string') return input.pattern;
	if (typeof input.path === 'string') return input.path;
	if (typeof input.description === 'string') return input.description;
	const s = JSON.stringify(input);
	return s.length > 200 ? s.slice(0, 200) : s;
}

export function rowStatus(tier: Tier | null, e: SessionEvents | undefined, t: TranscriptInfo | undefined): RowStatus {
	const hp = e?.prompt?.at;
	const tp = t?.prompt?.at;
	let turnAt: number | undefined;
	if (hp != null && tp != null) turnAt = Math.abs(hp - tp) < SAME_PROMPT_MS ? Math.min(hp, tp) : Math.max(hp, tp);
	else turnAt = hp ?? tp;
	const inTurn = <T extends {at: number}>(x: T | undefined) => (x && (turnAt == null || x.at >= turnAt) ? x : undefined);
	// the transcript speaks for the current turn only if its last instruction is that turn's
	const tr = t && (turnAt == null || (tp != null && tp >= turnAt - SAME_PROMPT_MS)) ? t : undefined;

	const prompt = inTurn(e?.prompt) ?? (tr?.prompt ? {at: tr.prompt.at, text: tr.prompt.text} : undefined);
	const midTurn = tier === 'Working' || tier === 'Permission';
	const stop = inTurn(e?.stop) ?? (tr?.answer && !midTurn ? {at: tr.answer.at, message: tr.answer.text} : undefined);
	const failure = inTurn(e?.failure) ?? (tr?.error ? {at: tr.error.at, error: tr.error.text, message: undefined} : undefined);
	const pend = tr?.pendingTool;
	const permission =
		inTurn(e?.permission) ??
		(pend && pend.tool !== 'AskUserQuestion' ? {at: pend.at, tool: pend.tool, target: describeTool(pend.input)} : undefined);
	const ask =
		inTurn(e?.ask) ??
		(pend && pend.tool === 'AskUserQuestion'
			? {at: pend.at, question: String(pend.input?.questions?.[0]?.question ?? pend.input?.question ?? '')}
			: undefined);

	let since: number | undefined;
	if (tier === 'Working') since = prompt?.at;
	else if (tier) {
		const hookTs = [inTurn(e?.stop), inTurn(e?.failure), inTurn(e?.permission), inTurn(e?.ask)].filter(Boolean).map(x => x!.at);
		if (hookTs.length) since = Math.max(...hookTs);
		else if (tr) since = tier === 'Permission' ? (permission?.at ?? tr.lastAt) : tr.lastAt;
	}

	let note: string | undefined;
	switch (tier) {
		case 'Working':
			if (prompt) note = `→ ${firstLine(prompt.text)}`;
			break;
		case 'Permission':
			if (permission) note = `${permission.tool}: ${firstLine(permission.target)}`;
			break;
		case 'Question':
			note = ask ? firstLine(ask.question) : headLine(stop?.message ?? tr?.lastText?.text);
			break;
		case 'Failed':
			note = failure?.error ? firstLine(failure.error) : headLine(failure?.message ?? stop?.message);
			break;
		default:
			if (tier) note = headLine(stop?.message);
	}
	return {note: note || undefined, since, bang: bangCommands(stop?.message)};
}
