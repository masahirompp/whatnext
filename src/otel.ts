import http from 'node:http';
import { hooksSettings, ingestHook } from './hooks.js';

export const OTEL_PORT = 14318;

type SessionStats = {
  lastEventAt?: number; // event time of the last log (ms), excluding Notification hooks
  receivedAt?: number; // wall-clock time we last received anything for it
  ctx?: number;
};

const stats = new Map<string, SessionStats>();
let listening = false;

function get(sid: string) {
  let s = stats.get(sid);
  if (!s) stats.set(sid, (s = {}));
  return s;
}

type Attr = { key: string; value: Record<string, unknown> };
function attrs(list: Attr[] | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const a of list ?? []) {
    const v = a.value ?? {};
    const x = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
    if (x !== undefined) out[a.key] = typeof x === 'string' && /^\d+$/.test(x) && a.key.endsWith('tokens') ? Number(x) : (x as string);
  }
  return out;
}

function nanoToMs(n: unknown) {
  if (n == null) return undefined;
  const v = Number(BigInt(String(n)) / 1000000n);
  return v > 0 ? v : undefined;
}

export function ingestLogs(body: any) {
  for (const rl of body.resourceLogs ?? []) {
    const res = attrs(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const a = { ...res, ...attrs(rec.attributes) };
        const sid = a['session.id'] as string | undefined;
        if (!sid) continue;
        const s = get(sid);
        s.receivedAt = Date.now();
        const name = String(a['event.name'] ?? rec.body?.stringValue ?? '');
        const isNotificationHook = name.includes('hook_execution') && a['hook_event'] === 'Notification';
        const t = nanoToMs(rec.timeUnixNano) ?? nanoToMs(rec.observedTimeUnixNano) ?? Date.now();
        if (!isNotificationHook && (s.lastEventAt === undefined || t > s.lastEventAt)) s.lastEventAt = t;
        if (name.endsWith('api_request') && String(a['query_source'] ?? '').startsWith('repl_main_thread')) {
          const n = (k: string) => Number(a[k] ?? 0) || 0;
          s.ctx = n('input_tokens') + n('cache_read_tokens') + n('cache_creation_tokens');
        }
      }
    }
  }
}

export function otelFor(sid: string) {
  const s = stats.get(sid);
  if (!s) return undefined;
  return { ctx: s.ctx, lastEventAt: s.lastEventAt, receivedAt: s.receivedAt };
}

export function otelListening() {
  return listening;
}

/** Asks whoever holds the port whether it is a whatnext. */
function whatnextAnswers(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: OTEL_PORT, path: '/v1/whatnext', timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body.includes('"app":"whatnext"')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Open the receiver on 127.0.0.1. 'taken' when some other program holds the
 * port (run without hooks and OTel), 'running' when another whatnext does.
 */
export function startOtel(): Promise<'listening' | 'taken' | 'running'> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/v1/whatnext')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"app":"whatnext"}');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (req.url?.startsWith('/v1/logs')) ingestLogs(body);
          else if (req.url?.startsWith('/v1/hooks')) ingestHook(body);
        } catch {
          // ignore malformed payloads
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    server.once('error', () => void whatnextAnswers().then((yes) => resolve(yes ? 'running' : 'taken')));
    server.listen(OTEL_PORT, '127.0.0.1', () => {
      listening = true;
      server.unref();
      resolve('listening');
    });
  });
}

/** --settings for sessions whatnext launches: OTel logs and the hook forwarder. */
export function launchSettingsJson() {
  const e = `http://127.0.0.1:${OTEL_PORT}`;
  return JSON.stringify({
    hooks: hooksSettings(OTEL_PORT),
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: e,
      OTEL_LOGS_EXPORT_INTERVAL: '2000',
    },
  });
}
