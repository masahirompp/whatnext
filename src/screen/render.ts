// 画面の組み立て: 一覧の画面に書く行を組み立てる。純粋な関数。

import {color, oneLine, padEnd, padStart, truncate, width} from './text.js';

export type TierName = 'permission' | 'question' | 'sandbox' | 'failed' | 'review' | 'working' | 'waiting' | 'stopped';

export interface Where {
  /** リポジトリ名(`repo/sub`)か、git でない場所のパスの末尾。 */
  repo: string;
  /** 既定でないブランチ名。 */
  branch?: string;
  worktree: boolean;
  pr?: {number: number; state: 'open' | 'draft' | 'merged' | 'closed'};
}

export interface ScreenRow {
  key: string;
  name: string;
  tty: boolean;
  midHold: boolean;
  depth: number;
  lastChain: boolean[];
  hasChildren: boolean;
  tier: TierName;
  status: string;
  transient?: 'stopping' | 'deleting';
  where?: Where;
  ctx?: number;
  since: number | null;
  /** 行の下に出す注記(一言、`⚙`、`↳ done`、`↳ 理由`)。 */
  notes: string[];
}

export interface UsageFrame {
  label: string;
  percent: number;
  resets?: string;
}

export type Panel =
  | {kind: 'input'; prompt: string; value: string; hint?: string; error?: string}
  | {
      kind: 'menu';
      title: string;
      items: {label: string; detail?: string; disabled?: boolean; marked?: boolean}[];
      selected: number;
      filter?: string;
      numbered?: boolean;
      footer?: string;
    }
  | {kind: 'confirm'; text: string}
  | {kind: 'text'; lines: string[]};

export interface ScreenModel {
  cols: number;
  rows: number;
  usage?: UsageFrame[];
  /** 固定する組(Last attached)の行。 */
  lastAttached?: ScreenRow[];
  /** 優先度ラダーの行。 */
  upNext: ScreenRow[];
  /** 保留の組の行。 */
  onHold?: ScreenRow[];
  cursor: string | null;
  /** 待機時間を数える基準の時刻(最後の更新の時刻)。 */
  asOf: number;
  /** 一覧の代わりに出す文言(取得の失敗、対象の行がないとき)。 */
  placeholder?: string;
  messages: string[];
  panel?: Panel;
  help: string;
}

const STATUS_COLOR: Record<TierName, (s: string) => string> = {
  permission: color.red,
  question: color.yellow,
  sandbox: color.magenta,
  failed: color.red,
  review: color.green,
  working: color.cyan,
  waiting: color.blue,
  stopped: color.gray,
};

const PR_COLOR = {open: color.green, draft: color.gray, merged: color.magenta, closed: color.red};

export function formatWaiting(since: number | null, asOf: number): string {
  if (since === null) return '-';
  const min = Math.floor(Math.max(0, asOf - since) / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${String(min % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

export function formatCtx(ctx: number | undefined): string {
  if (ctx === undefined) return '-';
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`;
  return `${Math.max(1, Math.round(ctx / 1000))}k`;
}

export function formatWhere(w: Where | undefined, colored: boolean): string {
  if (!w) return '';
  const parts = [w.repo];
  if (w.branch) parts.push(w.branch);
  if (w.worktree) parts.push('(wt)');
  if (w.pr) {
    const s = `#${w.pr.number} (${w.pr.state})`;
    parts.push(colored ? PR_COLOR[w.pr.state](s) : s);
  }
  return parts.join(' ');
}

export function formatUsage(frames: UsageFrame[]): string {
  return frames
    .map(f => {
      const pct = `${f.percent}%`;
      const c = f.percent >= 80 ? color.red(pct) : f.percent >= 50 ? color.yellow(pct) : pct;
      return `${f.label} ${c}${f.resets ? ` (resets ${f.resets})` : ''}`;
    })
    .join(' · ');
}

function treePrefix(r: ScreenRow): string {
  if (r.depth === 0) return '';
  let s = '';
  for (let i = 0; i < r.depth - 1; i++) s += r.lastChain[i] ? '  ' : '│ ';
  return s + (r.lastChain[r.depth - 1] ? '└ ' : '├ ');
}

function notePrefix(r: ScreenRow): string {
  let s = '';
  for (let i = 0; i < r.depth; i++) s += r.lastChain[i] ? '  ' : '│ ';
  return s + (r.hasChildren ? '│ ' : '  ');
}

function sessionLabel(r: ScreenRow): string {
  let s = treePrefix(r) + r.name;
  if (r.tty) s += ' (tty)';
  if (r.midHold) s += ' (on hold)';
  return s;
}

function statusText(r: ScreenRow): string {
  if (r.transient === 'stopping') return 'Stopping...';
  if (r.transient === 'deleting') return 'Deleting...';
  return r.status;
}

interface Columns {
  session: number;
  status: number;
  where: number;
}

const CTX_W = 5;
const WAIT_W = 7;
const GAP = 2;
const CURSOR_W = 2;

function columns(all: ScreenRow[], cols: number): Columns {
  const session = Math.min(32, Math.max(7, ...all.map(r => width(sessionLabel(r)))));
  const status = Math.max(6, ...all.map(r => width(statusText(r))));
  const whereMax = Math.max(5, ...all.map(r => width(formatWhere(r.where, false))));
  const rest = cols - CURSOR_W - session - status - CTX_W - WAIT_W - GAP * 4;
  return {session, status, where: Math.max(5, Math.min(whereMax, rest))};
}

function headerLine(c: Columns): string {
  return (
    ' '.repeat(CURSOR_W) +
    padEnd('SESSION', c.session) +
    ' '.repeat(GAP) +
    padEnd('STATUS', c.status) +
    ' '.repeat(GAP) +
    padEnd('WHERE', c.where) +
    ' '.repeat(GAP) +
    padStart('CTX', CTX_W) +
    ' '.repeat(GAP) +
    padStart('WAITING', WAIT_W)
  );
}

function rowLines(r: ScreenRow, c: Columns, selected: boolean, asOf: number, cols: number): string[] {
  const deleting = r.transient === 'deleting';
  const st = statusText(r);
  const statusCell = padEnd(st, c.status);
  const whereText = truncate(formatWhere(r.where, false), c.where);
  let whereCell: string;
  if (!deleting && r.where?.pr && whereText === formatWhere(r.where, false)) {
    whereCell = formatWhere(r.where, true) + ' '.repeat(Math.max(0, c.where - width(whereText)));
  } else whereCell = padEnd(whereText, c.where);
  const body =
    padEnd(sessionLabel(r), c.session) +
    ' '.repeat(GAP) +
    (deleting || r.transient ? statusCell : STATUS_COLOR[r.tier](statusCell)) +
    ' '.repeat(GAP) +
    whereCell +
    ' '.repeat(GAP) +
    padStart(formatCtx(r.ctx), CTX_W) +
    ' '.repeat(GAP) +
    padStart(formatWaiting(r.since, asOf), WAIT_W);
  const mark = selected ? '> ' : '  ';
  let main = mark + (selected && !deleting ? color.bold(body) : body);
  if (deleting) main = color.dim(mark + body);
  const out = [main];
  for (const n of r.notes) {
    const prefix = notePrefix(r);
    out.push(`  ${prefix}${color.gray(truncate(oneLine(n), Math.max(1, cols - CURSOR_W - width(prefix))))}`);
  }
  return out.map(l => (deleting ? color.dim(l) : l));
}

function block(rows: ScreenRow[], c: Columns, m: ScreenModel, lines: string[], rowAt?: Map<string, number>): void {
  for (const r of rows) {
    rowAt?.set(r.key, lines.length);
    lines.push(...rowLines(r, c, r.key === m.cursor, m.asOf, m.cols));
  }
}

/** メニューの項目のうち出す範囲。収まらないときは選んだ項目が見えるように窓を動かす。 */
function menuWindow(count: number, selected: number, max: number): {start: number; end: number} {
  if (count <= max) return {start: 0, end: count};
  const h = Math.max(1, max - 1); // 1行は通し番号に使う
  const start = Math.min(Math.max(0, selected - Math.floor(h / 2)), count - h);
  return {start, end: start + h};
}

function panelLines(p: Panel, cols: number, maxItems: number): string[] {
  switch (p.kind) {
    case 'input': {
      const out = [`${p.prompt} ${p.value}█`];
      if (p.error) out.push(color.red(p.error));
      if (p.hint) out.push(color.gray(p.hint));
      return out;
    }
    case 'confirm':
      return [color.yellow(p.text)];
    case 'text':
      return p.lines;
    case 'menu': {
      const out = [color.bold(p.title) + (p.filter !== undefined ? `  ${p.filter}█` : '')];
      const win = menuWindow(p.items.length, p.selected, maxItems);
      p.items.forEach((it, i) => {
        if (i < win.start || i >= win.end) return;
        const sel = i === p.selected && !it.disabled;
        const num = p.numbered && !it.disabled ? `(${i + 1}) ` : p.numbered ? '    ' : '';
        const mark = it.marked ? '✓ ' : p.items.some(x => x.marked) ? '  ' : '';
        const label = `${sel ? '> ' : '  '}${num}${mark}${it.label}`;
        const detail = it.detail ? `  ${color.gray(it.detail)}` : '';
        const line = truncate(label + detail, cols);
        out.push(it.disabled ? color.gray(line) : sel ? color.bold(line) : line);
      });
      if (win.end - win.start < p.items.length) out.push(color.gray(`  ${p.selected + 1}/${p.items.length}`));
      if (p.footer) out.push(color.gray(p.footer));
      return out;
    }
  }
}

/** 一覧の画面の行を組み立てる。返す行はどれも端末の幅に収まり、行数は端末の高さを超えない。 */
export function render(m: ScreenModel): string[] {
  const cols = Math.max(10, m.cols);
  const top: string[] = [];
  if (m.usage && m.usage.length > 0) top.push(formatUsage(m.usage));

  const bottom: string[] = [...m.messages.map(s => oneLine(s))];
  // メニューの項目は画面の半分ほどに収め、一覧のヘッダと何行かを残す。
  const maxItems = Math.max(3, Math.floor((m.rows - m.messages.length) / 2) - 2);
  if (m.panel) bottom.push(...panelLines(m.panel, cols, maxItems));
  bottom.push(color.gray(m.help));

  let middle: string[];
  if (m.placeholder !== undefined) {
    middle = ['', `  ${m.placeholder}`];
  } else {
    const allRows = [...(m.lastAttached ?? []), ...m.upNext, ...(m.onHold ?? [])];
    const c = columns(allRows, cols);
    top.push(headerLine(c));
    const fixedLines: string[] = [];
    const titled = m.lastAttached !== undefined || m.onHold !== undefined;
    if (m.lastAttached) {
      fixedLines.push(color.bold('  Last attached'));
      block(m.lastAttached, c, m, fixedLines);
    }
    if (titled) {
      if (fixedLines.length > 0) fixedLines.push('');
      fixedLines.push(color.bold('  Up next'));
    }
    const scrollLines: string[] = [];
    const rowAt = new Map<string, number>();
    block(m.upNext, c, m, scrollLines, rowAt);
    if (m.onHold) {
      scrollLines.push('', color.bold('  On hold'));
      block(m.onHold, c, m, scrollLines, rowAt);
    }
    const avail = Math.max(1, m.rows - top.length - fixedLines.length - bottom.length);
    if (scrollLines.length <= avail) {
      middle = [...fixedLines, ...scrollLines];
    } else {
      const winH = Math.max(1, avail - 1);
      const sel = m.cursor !== null ? rowAt.get(m.cursor) : undefined;
      let start = 0;
      if (sel !== undefined) start = Math.min(Math.max(0, sel - Math.floor(winH / 2)), scrollLines.length - winH);
      const idx = allRows.findIndex(r => r.key === m.cursor);
      middle = [
        ...fixedLines,
        ...scrollLines.slice(start, start + winH),
        color.gray(`  ${idx >= 0 ? idx + 1 : '-'}/${allRows.length}`),
      ];
    }
  }

  let lines = [...top, ...middle];
  const room = m.rows - lines.length;
  if (room < bottom.length) {
    // 下の欄が収まらないときは、キーの説明から削る。
    lines = [...lines, ...bottom.slice(0, Math.max(0, room))];
  } else {
    lines = [...lines, ...Array(room - bottom.length).fill(''), ...bottom];
  }
  return lines.slice(0, Math.max(1, m.rows)).map(l => truncate(l, cols));
}

/** 画面全体を1回の write で書き直す文字列(同期出力で囲む)。 */
export function frame(lines: string[]): string {
  return `\x1b[?2026h\x1b[H${lines.map(l => `${l}\x1b[K`).join('\r\n')}\x1b[J\x1b[?2026l`;
}
