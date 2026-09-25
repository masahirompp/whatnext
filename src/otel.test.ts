import { describe, expect, it } from 'vitest';
import { formatCost, formatTokens, OtelStore } from './otel.js';

const kv = (o: Record<string, string>) => Object.entries(o).map(([key, v]) => ({ key, value: { stringValue: v } }));
const metrics = (sid: string, model: string, v: number) => ({
  resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'claude_code.cost.usage', sum: { aggregationTemporality: 2, dataPoints: [{ asDouble: v, attributes: kv({ 'session.id': sid, model, query_source: 'main' }) }] } }] }] }],
});
const logs = (sid: string, ts: string, extra: Record<string, string> = {}) => ({
  resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: kv({ 'session.id': sid, 'event.timestamp': ts, ...extra }) }] }] }],
});

describe('OtelStore', () => {
  it('keeps the latest cumulative value per model and sums them', () => {
    const s = new OtelStore();
    s.ingest('/v1/metrics', metrics('s1', 'haiku', 0.1));
    s.ingest('/v1/metrics', metrics('s1', 'haiku', 0.3));
    s.ingest('/v1/metrics', metrics('s1', 'opus', 1));
    expect(s.costOf('s1')).toBeCloseTo(1.3);
    expect(s.costOf('s2')).toBeUndefined();
  });
  it('tracks the latest event, ignoring Notification hooks', () => {
    const s = new OtelStore();
    s.ingest('/v1/logs', logs('s1', '2026-09-25T00:00:02Z'));
    s.ingest('/v1/logs', logs('s1', '2026-09-25T00:00:01Z'));
    s.ingest('/v1/logs', logs('s1', '2026-09-25T00:01:00Z', { hook_event: 'Notification' }));
    expect(s.lastEvent.get('s1')).toBe(Date.parse('2026-09-25T00:00:02Z'));
  });
  it('takes the context size from the latest main-thread request only', () => {
    const s = new OtelStore();
    const req = (ts: string, qs: string, cr: string) => logs('s1', ts, {
      'event.name': 'api_request', query_source: qs, input_tokens: '10', cache_read_tokens: cr, cache_creation_tokens: '71',
    });
    s.ingest('/v1/logs', req('2026-09-25T00:00:01Z', 'repl_main_thread:outputStyle:custom', '35709'));
    s.ingest('/v1/logs', req('2026-09-25T00:00:02Z', 'prompt_suggestion', '99999'));
    expect(s.contextOf('s1')).toBe(35790);
    expect(s.contextOf('s2')).toBeUndefined();
  });
  it('formats tokens', () => {
    expect(formatTokens(undefined)).toBe('');
    expect(formatTokens(812)).toBe('812');
    expect(formatTokens(35790)).toBe('36k');
    expect(formatTokens(1_234_567)).toBe('1.2M');
  });
  it('formats cost', () => {
    expect(formatCost(undefined)).toBe('');
    expect(formatCost(0.0693)).toBe('$0.07');
    expect(formatCost(12.34)).toBe('$12.3');
  });
});
