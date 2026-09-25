// Trial (#58): receive OTLP/HTTP JSON from sessions that whatnext launched, in memory only.
import http from 'node:http';

export const OTLP_PORT = 14318;

// Passed to `claude --bg --settings`. The caller's shell env does not reach `--bg` sessions (#57).
export const OTEL_SETTINGS = JSON.stringify({
  env: {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${OTLP_PORT}`,
    // Cumulative so that a whatnext opened later gets the session total on the next export.
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_LOGS_EXPORT_INTERVAL: '1000',
  },
});

type Attr = { key: string; value: Record<string, unknown> };
const attrs = (a: Attr[] | undefined) =>
  Object.fromEntries((a ?? []).map((x) => [x.key, Object.values(x.value ?? {})[0]]));

export class OtelStore {
  // sessionId -> (point attributes -> latest cumulative cost)
  private cost = new Map<string, Map<string, number>>();
  // sessionId -> latest event.timestamp (ms)
  readonly lastEvent = new Map<string, number>();
  // sessionId -> tokens sent by the latest main-thread request (input + cache read + cache write),
  // i.e. the current context size. Matches the statusline's context figure.
  private context = new Map<string, { at: number; tokens: number }>();

  contextOf(sessionId: string): number | undefined {
    return this.context.get(sessionId)?.tokens;
  }

  costOf(sessionId: string): number | undefined {
    const m = this.cost.get(sessionId);
    if (!m) return undefined;
    let s = 0;
    for (const v of m.values()) s += v;
    return s;
  }

  ingest(path: string, body: unknown): void {
    const b = body as { resourceMetrics?: any[]; resourceLogs?: any[] };
    if (path.endsWith('/v1/metrics')) {
      for (const rm of b.resourceMetrics ?? []) for (const sm of rm.scopeMetrics ?? []) for (const m of sm.metrics ?? []) {
        if (m.name !== 'claude_code.cost.usage') continue;
        for (const d of m.sum?.dataPoints ?? []) {
          const a = attrs(d.attributes);
          const sid = a['session.id'];
          const v = Number(d.asDouble ?? d.asInt);
          if (typeof sid !== 'string' || !Number.isFinite(v)) continue;
          const key = JSON.stringify([a.model, a.query_source]);
          if (!this.cost.has(sid)) this.cost.set(sid, new Map());
          this.cost.get(sid)!.set(key, v);
        }
      }
    } else if (path.endsWith('/v1/logs')) {
      for (const rl of b.resourceLogs ?? []) for (const sl of rl.scopeLogs ?? []) for (const r of sl.logRecords ?? []) {
        const a = attrs(r.attributes);
        const sid = a['session.id'];
        if (typeof sid !== 'string') continue;
        // A Notification hook fires while the session is already waiting; it is not activity.
        if (a.hook_event === 'Notification') continue;
        const t = Date.parse(String(a['event.timestamp']));
        if (!Number.isFinite(t)) continue;
        if (t > (this.lastEvent.get(sid) ?? 0)) this.lastEvent.set(sid, t);
        // Subagents and side requests (prompt suggestions, titles) have other query sources.
        if (a['event.name'] === 'api_request' && String(a.query_source ?? '').startsWith('repl_main_thread')) {
          const tokens = ['input_tokens', 'cache_read_tokens', 'cache_creation_tokens']
            .reduce((n, k) => n + (Number(a[k]) || 0), 0);
          if (t >= (this.context.get(sid)?.at ?? 0)) this.context.set(sid, { at: t, tokens });
        }
      }
    }
  }
}

// Returns null if the port is taken (e.g. another whatnext); the list then works without OTel.
export function startReceiver(store: OtelStore, onData: () => void): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          store.ingest(req.url ?? '', JSON.parse(Buffer.concat(chunks).toString('utf8')));
          onData();
        } catch { /* ignore malformed or non-JSON exports */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    server.once('error', () => resolve(null));
    server.listen(OTLP_PORT, '127.0.0.1', () => { server.unref(); resolve(server); });
  });
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(c: number | undefined): string {
  if (c === undefined) return '';
  return c < 10 ? `$${c.toFixed(2)}` : `$${c.toFixed(1)}`;
}
