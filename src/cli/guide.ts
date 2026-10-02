// cli: 作業台の画面の案内(作業台がないことと作ったときの場所を描き、`Enter` で作業台を作る頼みごとを一覧に渡す)。
// 案内のセッション `wbguide` の中で動く。

import {execFileSync} from 'node:child_process';
import {emitKeypressEvents} from 'node:readline';
import {truncate} from '../screen/text.js';

const socket = process.env.WHATNEXT_TMUX_SOCKET || 'whatnext';
const tmux = (...args: string[]): string => {
  try {
    return execFileSync('tmux', ['-L', socket, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  } catch {
    return '';
  }
};

interface Info {
  id?: string;
  text: string[];
}

function info(): Info {
  try {
    const raw = tmux('show', '-gv', '@wn_guide').replace(/\n$/, '');
    const v = JSON.parse(raw) as Info;
    return Array.isArray(v.text) ? v : {text: []};
  } catch {
    return {text: []};
  }
}

let current: Info = {text: []};

function draw(): void {
  current = info();
  const cols = process.stdout.columns || 80;
  const lines = current.text.map(l => truncate(l, cols));
  process.stdout.write(`\x1b[?2026h\x1b[H${lines.map(l => `${l}\x1b[K`).join('\r\n')}\x1b[J\x1b[?2026l`);
}

tmux('set', '-g', '@wn_guide_pid', String(process.pid));
process.stdout.write('\x1b[?1049h\x1b[?25l');
emitKeypressEvents(process.stdin, {escapeCodeTimeout: 30} as never);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('keypress', (_s: string | undefined, k: {name?: string} | undefined) => {
  if (k?.name !== 'return') return;
  const id = info().id;
  if (!id) return;
  tmux('set', '-g', `@wn_req_${Math.floor(Date.now() / 1000)}_${process.pid}${Date.now() % 1000}`, `wbcreate ${id}`);
  const pid = Number(tmux('show', '-gv', '@wn_pid').trim());
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGUSR2');
    } catch {}
  }
});
process.stdin.resume();
process.on('SIGUSR2', draw);
process.on('SIGWINCH', draw);
process.stdout.on('resize', draw);
process.on('SIGINT', () => {});
draw();
