// フックと OTel の受け口(127.0.0.1:<PORT>)。受けた値はメモリにだけ持つ。
import {createServer, type Server} from 'node:http';
import {PORT} from './env.js';

export type HookState = {
	prompt?: {text: string; ts: number};
	stop?: {text: string; ts: number};
	stopFailure?: {text?: string; error?: string; ts: number};
	permission?: {tool: string; input: unknown; ts: number};
	ask?: {question: string; ts: number};
	prompts: number; // 受けた UserPromptSubmit の数(保留を解く判定)
};

export const hooks = new Map<string, HookState>();
export const ctx = new Map<string, number>();

const state = (sid: string): HookState => {
	let s = hooks.get(sid);
	if (!s) hooks.set(sid, (s = {prompts: 0}));
	return s;
};

function onHook(body: Record<string, unknown>) {
	const sid = String(body.session_id ?? '');
	if (!sid) return;
	const s = state(sid);
	const ts = Date.now();
	switch (body.hook_event_name) {
		case 'UserPromptSubmit':
			s.prompt = {text: String(body.prompt ?? ''), ts};
			s.prompts++;
			break;
		case 'Stop':
			s.stop = {text: String(body.last_assistant_message ?? ''), ts};
			break;
		case 'StopFailure':
			s.stopFailure = {
				text: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : undefined,
				error: typeof body.error === 'string' ? body.error : undefined,
				ts,
			};
			break;
		case 'PermissionRequest':
			s.permission = {tool: String(body.tool_name ?? ''), input: body.tool_input, ts};
			break;
		case 'PreToolUse':
			if (body.tool_name === 'AskUserQuestion') {
				const q = (body.tool_input as {questions?: Array<{question?: string}>})?.questions?.[0]?.question;
				if (q) s.ask = {question: q, ts};
			}
			break;
	}
}

type Attr = {key: string; value: {stringValue?: string; intValue?: string | number; doubleValue?: number}};
const attrs = (list: Attr[] | undefined) => {
	const out: Record<string, string | number> = {};
	for (const a of list ?? []) out[a.key] = a.value.stringValue ?? Number(a.value.intValue ?? a.value.doubleValue ?? 0);
	return out;
};

// OTLP/JSON の logs から、本体のターンの api_request の token 数(CTX)を取る
function onLogs(body: {resourceLogs?: Array<{resource?: {attributes?: Attr[]}; scopeLogs?: Array<{logRecords?: Array<{attributes?: Attr[]; body?: {stringValue?: string}}>}>}>}) {
	for (const rl of body.resourceLogs ?? []) {
		const res = attrs(rl.resource?.attributes);
		for (const sl of rl.scopeLogs ?? []) {
			for (const rec of sl.logRecords ?? []) {
				const a = {...res, ...attrs(rec.attributes)};
				const name = String(a['event.name'] ?? rec.body?.stringValue ?? '');
				if (!name.endsWith('api_request')) continue;
				if (!String(a.query_source ?? '').startsWith('repl_main_thread')) continue;
				const sid = String(a['session.id'] ?? '');
				if (!sid) continue;
				ctx.set(sid, Number(a.input_tokens ?? 0) + Number(a.cache_read_tokens ?? 0) + Number(a.cache_creation_tokens ?? 0));
			}
		}
	}
}

let server: Server | undefined;
export let receiverOpen = false;

// 開ければ true。ポートが使われていれば false(フックと OTel を付けずに動く)。
export function openReceiver(): Promise<boolean> {
	return new Promise(resolve => {
		server = createServer((req, res) => {
			if (req.method === 'GET' && req.url === '/v1/whatnext') {
				res.setHeader('content-type', 'application/json');
				res.end('{"app":"whatnext"}');
				return;
			}
			const chunks: Buffer[] = [];
			req.on('data', c => chunks.push(c));
			req.on('end', () => {
				res.setHeader('content-type', 'application/json');
				res.end('{}');
				let body: unknown;
				try {
					body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				} catch {
					return;
				}
				if (req.url === '/v1/hooks') onHook(body as Record<string, unknown>);
				else if (req.url === '/v1/logs') onLogs(body as Parameters<typeof onLogs>[0]);
			});
		});
		server.once('error', () => resolve(false));
		server.listen(PORT, '127.0.0.1', () => {
			receiverOpen = true;
			resolve(true);
		});
	});
}

// n で起動するセッションに付ける --settings
export function launchSettings(): string | undefined {
	if (!receiverOpen) return undefined;
	const command = `curl -s -m 1 -o /dev/null --data-binary @- http://127.0.0.1:${PORT}/v1/hooks; exit 0`;
	const h = [{hooks: [{type: 'command', command}]}];
	return JSON.stringify({
		hooks: {
			UserPromptSubmit: h,
			Stop: h,
			StopFailure: h,
			PermissionRequest: h,
			PreToolUse: [{matcher: 'AskUserQuestion', hooks: [{type: 'command', command}]}],
		},
		env: {
			CLAUDE_CODE_ENABLE_TELEMETRY: '1',
			OTEL_LOGS_EXPORTER: 'otlp',
			OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
			OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${PORT}`,
			OTEL_LOGS_EXPORT_INTERVAL: '2000',
		},
	});
}
