// Receives hooks and OTel logs from sessions launched by whatnext.
import http from 'node:http';

// WHATNEXT_PORT is for testing next to a running whatnext; users never set it.
export const PORT = Number(process.env.WHATNEXT_PORT) || 14318;
export const HOOK_URL = `http://127.0.0.1:${PORT}/v1/hooks`;

export type Stamp<T> = {at: number} & T;

export type SessionEvents = {
	prompt?: Stamp<{text: string}>;
	stop?: Stamp<{message?: string}>;
	failure?: Stamp<{error?: string; message?: string}>;
	permission?: Stamp<{tool: string; target: string}>;
	ask?: Stamp<{question: string}>;
	ctx?: number;
	count: number; // number of hook/otel events, used to detect "worked"
};

export const events = new Map<string, SessionEvents>();

function get(sid: string): SessionEvents {
	let e = events.get(sid);
	if (!e) {
		e = {count: 0};
		events.set(sid, e);
	}
	return e;
}

function describeTool(tool: string, input: any): string {
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

export function handleHook(body: any, now = Date.now()) {
	const sid = body?.session_id;
	if (typeof sid !== 'string') return;
	const e = get(sid);
	e.count++;
	switch (body.hook_event_name) {
		case 'UserPromptSubmit':
			e.prompt = {at: now, text: String(body.prompt ?? '')};
			break;
		case 'Stop':
			e.stop = {at: now, message: body.last_assistant_message};
			break;
		case 'StopFailure':
			e.failure = {
				at: now,
				error: [body.error, body.error_details].filter(Boolean).join(': ') || undefined,
				message: body.last_assistant_message,
			};
			break;
		case 'PermissionRequest':
			e.permission = {
				at: now,
				tool: String(body.tool_name ?? '?'),
				target: describeTool(body.tool_name, body.tool_input),
			};
			break;
		case 'PreToolUse':
			if (body.tool_name === 'AskUserQuestion') {
				const q = body.tool_input?.questions?.[0]?.question ?? body.tool_input?.question;
				e.ask = {at: now, question: String(q ?? '')};
			}
			break;
	}
}

function attr(attrs: any[] | undefined, key: string): any {
	const a = attrs?.find(x => x.key === key);
	if (!a) return undefined;
	const v = a.value ?? {};
	return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
}

export function handleLogs(body: any) {
	for (const rl of body?.resourceLogs ?? []) {
		for (const sl of rl.scopeLogs ?? []) {
			for (const rec of sl.logRecords ?? []) {
				const attrs = rec.attributes;
				const sid = attr(attrs, 'session.id');
				if (typeof sid !== 'string') continue;
				const e = get(sid);
				e.count++;
				const name = String(attr(attrs, 'event.name') ?? rec.body?.stringValue ?? '');
				if (!name.endsWith('api_request')) continue;
				const qs = String(attr(attrs, 'query_source') ?? '');
				if (!qs.startsWith('repl_main_thread')) continue;
				const n = (k: string) => Number(attr(attrs, k) ?? 0) || 0;
				e.ctx = n('input_tokens') + n('cache_read_tokens') + n('cache_creation_tokens');
			}
		}
	}
}

/** 'ok' | 'other-whatnext' | 'busy' (port used by something else) */
export async function startReceiver(): Promise<'ok' | 'other-whatnext' | 'busy'> {
	const server = http.createServer((req, res) => {
		if (req.method === 'GET' && req.url === '/v1/whatnext') {
			res.writeHead(200, {'content-type': 'application/json'});
			res.end('{"app":"whatnext"}');
			return;
		}
		const chunks: Buffer[] = [];
		req.on('data', c => chunks.push(c));
		req.on('end', () => {
			let body: any;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			} catch {
				body = undefined;
			}
			try {
				if (req.url === '/v1/hooks') handleHook(body);
				else if (req.url === '/v1/logs') handleLogs(body);
			} catch {}
			res.writeHead(200, {'content-type': 'application/json'});
			res.end('{}');
		});
	});
	const listened = await new Promise<boolean>(resolve => {
		server.once('error', () => resolve(false));
		server.listen(PORT, '127.0.0.1', () => resolve(true));
	});
	if (listened) {
		server.unref();
		return 'ok';
	}
	const isWhatnext = await new Promise<boolean>(resolve => {
		const req = http.get(
			{host: '127.0.0.1', port: PORT, path: '/v1/whatnext', timeout: 1000},
			res => {
				let s = '';
				res.on('data', c => (s += c));
				res.on('end', () => {
					try {
						resolve(JSON.parse(s)?.app === 'whatnext');
					} catch {
						resolve(s.trim() === 'whatnext');
					}
				});
			},
		);
		req.on('error', () => resolve(false));
		req.on('timeout', () => {
			req.destroy();
			resolve(false);
		});
	});
	return isWhatnext ? 'other-whatnext' : 'busy';
}

export function launchSettings(): string {
	const hook = `curl -s -m 1 -o /dev/null --data-binary @- ${HOOK_URL}; exit 0`;
	const h = [{hooks: [{type: 'command', command: hook}]}];
	return JSON.stringify({
		hooks: {
			UserPromptSubmit: h,
			Stop: h,
			StopFailure: h,
			PermissionRequest: h,
			PreToolUse: [{matcher: 'AskUserQuestion', hooks: [{type: 'command', command: hook}]}],
		},
		env: {
			CLAUDE_CODE_ENABLE_TELEMETRY: '1',
			OTEL_LOGS_EXPORTER: 'otlp',
			OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${PORT}/v1/logs`,
			OTEL_LOGS_EXPORT_INTERVAL: '2000',
		},
	});
}
