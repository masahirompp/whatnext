#!/usr/bin/env node
// 実機の通し(シナリオ 77)の最小の HTTP の MCP サーバ(#273 の構成)。
// tools/call を受けると、要求のヘッダ X-MCP-Caller-Pid の値を子の環境変数 MCP_CALLER_PID に入れて claude -p を起動する
// (ヘッダがないときは渡さない)。受けたヘッダは $LOG に書く。
// 使い方: node mcp-server.mjs <port> <log> [pass|drop]
import {spawn} from 'node:child_process';
import {appendFileSync, openSync} from 'node:fs';
import {createServer} from 'node:http';

const [port, log, mode = 'pass'] = process.argv.slice(2);
const note = obj => appendFileSync(log, `${JSON.stringify({at: Date.now(), ...obj})}\n`);

const tool = {
  name: 'spawn',
  description: 'Start a background worker that runs for about a minute.',
  inputSchema: {type: 'object', properties: {label: {type: 'string'}}, required: []},
};

createServer((req, res) => {
  let body = '';
  req.on('data', c => {
    body += c;
  });
  req.on('end', () => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const caller = req.headers['x-mcp-caller-pid'];
    note({method: msg.method, caller: caller ?? null});
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: {tools: {}},
        serverInfo: {name: 'wn-spawner', version: '0.0.1'},
      };
    } else if (msg.method === 'tools/list') {
      result = {tools: [tool]};
    } else if (msg.method === 'tools/call') {
      const env = {...process.env};
      delete env.MCP_CALLER_PID;
      if (mode === 'pass' && caller) env.MCP_CALLER_PID = String(caller);
      const label = msg.params?.arguments?.label ?? 'worker';
      const child = spawn(
        'claude',
        [
          '-p',
          `Count from 1 to 400 in English words, one number per line. Do not use any tools. After the last line, write the single word ${label}.`,
          '--model',
          'haiku',
        ],
        {
          env,
          detached: true,
          stdio: ['ignore', openSync(`${log}.${label}.out`, 'a'), openSync(`${log}.${label}.err`, 'a')],
          cwd: process.env.WN_WORK ?? process.cwd(),
        },
      );
      note({spawned: child.pid, label, passed: env.MCP_CALLER_PID ?? null});
      child.on('exit', (code, signal) => note({exited: child.pid, label, code, signal}));
      child.unref();
      result = {content: [{type: 'text', text: `started ${label}`}]};
    } else {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({jsonrpc: '2.0', id: msg.id, error: {code: -32601, message: 'not found'}}));
      return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({jsonrpc: '2.0', id: msg.id, result}));
  });
}).listen(Number(port), '127.0.0.1');
