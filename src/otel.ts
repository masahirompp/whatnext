import http from 'node:http';

export const OTEL_PORT = 14318;

type SessionStats = {
  lastEventAt?: number; // event time of the last log (ms), excluding Notification hooks
  receivedAt?: number; // wall-clock time we last received anything for it
  ctx?: number;
  costByKey: Map<string, number>;
};

const stats = new Map<string, SessionStats>();
let listening = false;

function get(sid: string) {
  let s = stats.get(sid);
  if (!s) stats.set(sid, (s = { costByKey: new Map() }));
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

export function ingestMetrics(body: any) {
  for (const rm of body.resourceMetrics ?? []) {
    const res = attrs(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        if (!String(m.name).endsWith('cost.usage')) continue;
        for (const dp of m.sum?.dataPoints ?? []) {
          const a = { ...res, ...attrs(dp.attributes) };
          const sid = a['session.id'] as string | undefined;
          if (!sid) continue;
          const s = get(sid);
          s.receivedAt = Date.now();
          const key = JSON.stringify(Object.entries(a).filter(([k]) => k !== 'session.id').sort());
          const v = Number(dp.asDouble ?? dp.asInt ?? 0);
          if (m.sum?.aggregationTemporality === 1) s.costByKey.set(key, (s.costByKey.get(key) ?? 0) + v);
          else s.costByKey.set(key, v);
        }
      }
    }
  }
}

export function otelFor(sid: string) {
  const s = stats.get(sid);
  if (!s) return undefined;
  const cost = s.costByKey.size ? [...s.costByKey.values()].reduce((a, b) => a + b, 0) : undefined;
  return { ctx: s.ctx, cost, lastEventAt: s.lastEventAt, receivedAt: s.receivedAt };
}

export function otelListening() {
  return listening;
}

/** Open the receiver on 127.0.0.1. Resolves false (silently) if the port is taken. */
export function startOtel(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (req.url?.startsWith('/v1/logs')) ingestLogs(body);
          else if (req.url?.startsWith('/v1/metrics')) ingestMetrics(body);
        } catch {
          // ignore malformed payloads
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    server.once('error', () => resolve(false));
    server.listen(OTEL_PORT, '127.0.0.1', () => {
      listening = true;
      server.unref();
      resolve(true);
    });
  });
}

export function otelSettingsJson() {
  const e = `http://127.0.0.1:${OTEL_PORT}`;
  return JSON.stringify({
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: e,
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
      OTEL_LOGS_EXPORT_INTERVAL: '2000',
    },
  });
}
