#!/usr/bin/env node
// statusline のタップ(#15): Claude Code が statusline のコマンドに渡す JSON をセッションごとに保存し、
// 引数で渡された元の statusline のコマンドにそのまま流す。書き込むのはこのコマンドで、whatnext 本体は読むだけ(ADR-0002)。
//   "command": "whatnext-statusline-tap npx -y ccstatusline@2.2.30"
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { statuslineDir } from './statusline.js';

const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function save(input: string) {
  const sid = JSON.parse(input)?.session_id;
  if (typeof sid !== 'string' || !/^[A-Za-z0-9-]+$/.test(sid)) return;
  const dir = statuslineDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${sid}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, input);
  fs.renameSync(tmp, path.join(dir, `${sid}.json`));
  // 溜まり続けないように、ときどき30日より古いものを消す
  if (Math.random() < 0.01) {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (now - fs.statSync(p).mtimeMs > PRUNE_AFTER_MS) fs.rmSync(p, { force: true });
    }
  }
}

const chunks: Buffer[] = [];
process.stdin.on('data', (c: Buffer) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString('utf8');
  // 保存に失敗しても、元の statusline の表示は必ず続ける
  try {
    save(input);
  } catch {}
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) return;
  const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', (e) => {
    process.stderr.write(`whatnext-statusline-tap: ${e.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code) => (process.exitCode = code ?? 1));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});
