#!/usr/bin/env node
// cycle 6 試作: Ink を使わずに一覧を描き、readline でキーを受ける。
// 撤退の条件(DESIGN.md「Ink を外す案」)を確かめるためだけのもの。依存なし。
import readline from 'node:readline';
import fs from 'node:fs';

const LOG = process.env.PROTO_LOG;
const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify({t: performance.now().toFixed(1), ...o}) + '\n');

const out = process.stdout;
const stdin = process.stdin;

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u;
const seg = new Intl.Segmenter();
const graphemes = (s) => [...seg.segment(s)].map((x) => x.segment);
const width = (s) => graphemes(s).reduce((w, g) => w + (WIDE.test(g) ? 2 : 1), 0);
const truncate = (s, max) => {
  let w = 0, r = '';
  for (const g of graphemes(s)) {
    const gw = WIDE.test(g) ? 2 : 1;
    if (w + gw > max) return r.slice(0, -1) + '…';
    w += gw; r += g;
  }
  return r;
};

const STATUSES = ['Permission', 'Question', 'Sandbox', 'Failed', 'Review', 'Working', 'Waiting', 'Stopped'];
const rows = Array.from({length: 40}, (_, i) => ({
  name: `session-${String(i + 1).padStart(2, '0')}`,
  status: STATUSES[i % STATUSES.length],
  where: i % 3 ? `app feature-${i} (wt)` : 'whatnext main',
  note: i % 2 ? '→ テストを直して、失敗しているケースを調べてください' : 'レビューをお願いします。変更点は3つです。',
}));

let cursor = 0;
let mode = 'list'; // list | input
let input = '';
let message = '';
let pasting = null; // 貼り付けの途中なら、ためている文字列
let renders = 0;
let lastKey = '';

function frame() {
  const cols = out.columns || 80, lines = out.rows || 24;
  const header = ['  SESSION        STATUS      WHERE                    WAITING'];
  const footer = [];
  if (mode === 'input') footer.push(`Put ${rows[cursor].name} on hold. Reason (optional): ${input}▌`);
  footer.push(message || ' ');
  footer.push(`↑↓ select  h hold  Esc cancel  q quit   [renders ${renders}  last ${lastKey}]`);
  const body = [];
  rows.forEach((r, i) => {
    body.push({i, text: `${i === cursor ? '>' : ' '} ${r.name.padEnd(14)} ${r.status.padEnd(11)} ${r.where.padEnd(24)} ${String(i + 1).padStart(4)}m`});
    body.push({i, text: `    \x1b[2m${r.note}\x1b[22m`, raw: r.note});
  });
  const room = Math.max(1, lines - header.length - footer.length - 1);
  const sel = body.findIndex((b) => b.i === cursor);
  let top = 0;
  if (body.length > room) top = Math.min(Math.max(0, sel - Math.floor(room / 2)), body.length - room);
  const visible = body.slice(top, top + room).map((b) => b.raw !== undefined ? `    \x1b[2m${truncate(b.raw, cols - 4)}\x1b[22m` : truncate(b.text, cols));
  const scroll = body.length > room ? [`${cursor + 1}/${rows.length}`] : [];
  return [...header.map((h) => truncate(h, cols)), ...visible, ...scroll, ...footer.map((f) => truncate(f, cols))];
}

let scheduled = false;
function render() {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    renders++;
    const lines = frame();
    // 画面全体を1回の write で、同期出力に囲んで書き直す。消してから描かない。
    const s = '\x1b[?2026h\x1b[H' + lines.map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J\x1b[?2026l';
    out.write(s);
    log({ev: 'render', n: renders, bytes: s.length});
  });
}

function onKey(str, key = {}) {
  lastKey = key.sequence ? JSON.stringify(key.sequence) : JSON.stringify(str);
  log({ev: 'key', name: key.name, ctrl: key.ctrl, meta: key.meta, seq: key.sequence, str});
  if (key.name === 'paste-start') { pasting = ''; return; }
  if (key.name === 'paste-end') {
    const text = pasting ?? '';
    pasting = null;
    log({ev: 'paste', text});
    if (mode === 'input') input += text.replace(/[\r\n]/g, '');
    message = `Pasted ${graphemes(text).length} chars in one piece.`;
    return render();
  }
  if (pasting !== null) { pasting += str ?? key.sequence ?? ''; return; }

  if (key.ctrl && key.name === 'c') return quit();
  if (mode === 'input') {
    if (key.name === 'escape') { mode = 'list'; input = ''; message = 'Cancelled.'; log({ev: 'escape'}); }
    else if (key.name === 'return') { message = `Put ${rows[cursor].name} on hold: ${input || '(no reason)'}`; mode = 'list'; input = ''; }
    else if (key.name === 'backspace') input = graphemes(input).slice(0, -1).join('');
    else if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) input += str;
    return render();
  }
  if (key.name === 'down') cursor = Math.min(rows.length - 1, cursor + 1);
  else if (key.name === 'up') cursor = Math.max(0, cursor - 1);
  else if (key.name === 'pagedown') cursor = Math.min(rows.length - 1, cursor + 10);
  else if (key.name === 'pageup') cursor = Math.max(0, cursor - 10);
  else if (key.ctrl && key.name === 'x') message = `Ctrl+X on ${rows[cursor].name}`;
  else if (key.name === 'escape') { message = 'Esc'; log({ev: 'escape'}); }
  else if (str === 'h') { mode = 'input'; input = ''; message = ''; }
  else if (str === 'q') return quit();
  render();
}

function quit() {
  out.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
  stdin.setRawMode(false);
  process.exit(0);
}

stdin.on('data', (d) => log({ev: 'data', hex: Buffer.from(d).toString('hex')}));
readline.emitKeypressEvents(stdin, {escapeCodeTimeout: 30});
stdin.setRawMode(true);
stdin.on('keypress', onKey);
out.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
process.on('SIGWINCH', () => { log({ev: 'winch', cols: out.columns, rows: out.rows}); render(); });
render();
