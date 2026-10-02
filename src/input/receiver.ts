// 入力: フックと OTel の受け口(127.0.0.1 の HTTP)。whatnext が動いている間だけ開く。

import {createServer, request, type Server} from 'node:http';
import type {HookStore} from './hooks.js';

export type Occupant = 'free' | 'whatnext' | 'other';

/** ポートを誰が使っているかを `GET /v1/whatnext` で確かめる。 */
export function probe(port: number, timeoutMs = 1000): Promise<Occupant> {
  return new Promise(resolve => {
    const req = request({host: '127.0.0.1', port, path: '/v1/whatnext', method: 'GET', timeout: timeoutMs}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => {
        body += d;
      });
      res.on('end', () => resolve(/whatnext/.test(body) ? 'whatnext' : 'other'));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve('other');
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED' ? 'free' : 'other'));
    req.end();
  });
}

export interface Receiver {
  close(): void;
}

/** 受け口を開く。ポートを別のプログラムが使っていれば null を返す。 */
export function openReceiver(port: number, store: HookStore): Promise<Receiver | null> {
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/whatnext') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end('{"app":"whatnext"}');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end('{}');
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return;
      }
      try {
        if (req.url === '/v1/hooks') store.receiveHook(body);
        else if (req.url === '/v1/logs') store.receiveLogs(body);
      } catch {}
    });
  });
  return new Promise(resolve => {
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve({close: () => server.close()}));
  });
}

/** `n` で起動するセッションに付ける `--settings` の中身(フックと OTel)。 */
export function launchSettings(port: number): string {
  const hook = {
    type: 'command',
    command: `curl -s -m 1 -o /dev/null --data-binary @- http://127.0.0.1:${port}/v1/hooks; exit 0`,
  };
  const on = [{hooks: [hook]}];
  return JSON.stringify({
    hooks: {
      UserPromptSubmit: on,
      Stop: on,
      StopFailure: on,
      PermissionRequest: on,
      PreToolUse: [{matcher: 'AskUserQuestion', hooks: [hook]}],
    },
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_LOGS_EXPORT_INTERVAL: '2000',
    },
  });
}
