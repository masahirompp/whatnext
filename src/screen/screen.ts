import {color, oneLine, padEnd, padStart, truncate, width} from '../../lib/text/text.js';
import type {Screen, ScreenRow, Tone} from './types.js';

// 一覧の画面を組み立てる(PRODUCT.md「一覧の表示」「リポジトリの区切りと並び」)。外部に触れない純粋な関数。

const NAME_MAX = 48;
const GAP = '  ';

export function formatWaiting(ms: number | undefined): string {
  if (ms === undefined) return '-';
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function formatCtx(n: number | undefined): string {
  if (n === undefined) return '-';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const toneColor: Record<Tone, (s: string) => string> = {
  permission: s => color.red(color.bold(s)),
  question: color.yellow,
  sandbox: color.yellow,
  failed: color.red,
  review: color.green,
  working: color.cyan,
  waiting: color.magenta,
  stopped: color.gray,
};

const prColor = {open: color.green, draft: color.gray, merged: color.magenta, closed: color.red} as const;

function whereText(r: ScreenRow, colored: boolean): string {
  const parts: string[] = [];
  const head = [r.where.repo, r.where.sub].filter(Boolean).join('/');
  if (head) parts.push(head);
  if (r.where.branch) parts.push(r.where.branch);
  if (r.where.worktree) parts.push('(wt)');
  if (r.where.pr) {
    const t = `#${r.where.pr.number} (${r.where.pr.state})`;
    parts.push(colored ? prColor[r.where.pr.state](t) : t);
  }
  return parts.join(' ');
}

/** 行の名前の左の線(`├ ` `└ ` と祖先の `│ `)。 */
export function rowPrefix(r: Pick<ScreenRow, 'depth' | 'last' | 'ancestorsLast'>): string {
  if (r.depth === 0) return '';
  return r.ancestorsLast.map(l => (l ? '  ' : '│ ')).join('') + (r.last ? '└ ' : '├ ');
}

/** 行の下の注記の左の線。祖先と自分の兄弟の縦線、子があれば自分の縦線を引き継ぐ。 */
export function annotationPrefix(r: Pick<ScreenRow, 'depth' | 'last' | 'ancestorsLast' | 'hasChildren'>): string {
  const lines = r.depth === 0 ? '' : [...r.ancestorsLast, r.last].map(l => (l ? '  ' : '│ ')).join('');
  return lines + (r.hasChildren ? '│ ' : '  ');
}

const nameText = (r: ScreenRow) => (r.marker ? `${r.name} (${r.marker})` : r.name);

/** 注記の文字列(一言、`⚙`、`↳ done`、`↳ メモ` の順)。 */
export function annotations(r: ScreenRow): {kind: 'line' | 'running' | 'done' | 'note'; text: string}[] {
  const out: {kind: 'line' | 'running' | 'done' | 'note'; text: string}[] = [];
  if (r.line) out.push({kind: 'line', text: oneLine(r.line)});
  if (r.running && r.running.length > 0) out.push({kind: 'running', text: `⚙ ${r.running.map(oneLine).join(' · ')}`});
  if (r.done && r.done.length > 0) out.push({kind: 'done', text: `↳ ${r.done.join(', ')} done`});
  if (r.note) out.push({kind: 'note', text: `↳ ${oneLine(r.note)}`});
  return out;
}

interface Cols {
  sess: number;
  status: number;
  where: number;
  ctx: number;
  wait: number;
}

function columns(s: Screen): Cols {
  const rows = s.groups.flatMap(g => g.rows);
  const sess = Math.max(
    width('SESSION'),
    ...rows.map(r => width(rowPrefix(r)) + Math.min(width(nameText(r)), NAME_MAX)),
  );
  const status = Math.max(width('STATUS'), ...rows.map(r => width(r.status)));
  const where = Math.max(width('WHERE'), ...rows.map(r => width(whereText(r, false))));
  const ctx = Math.max(3, ...rows.map(r => width(formatCtx(r.ctx))));
  const wait = width('WAITING');
  const cols = {sess, status, where, ctx, wait};
  const total = () => 2 + cols.sess + cols.status + cols.where + cols.ctx + cols.wait + GAP.length * 4;
  // 端末の幅が足りないときは WHERE から詰める
  if (total() > s.width) cols.where = Math.max(width('WHERE'), cols.where - (total() - s.width));
  if (total() > s.width) cols.sess = Math.max(width('SESSION') + 3, cols.sess - (total() - s.width));
  return cols;
}

function clip(line: string, w: number): string {
  return width(line) > w ? truncate(line, w) : line;
}

function header(c: Cols, w: number): string {
  const h = `  ${padEnd('SESSION', c.sess)}${GAP}${padEnd('STATUS', c.status)}${GAP}${padEnd('WHERE', c.where)}${GAP}${padStart('CTX', c.ctx)}${GAP}${padStart('WAITING', c.wait)}`;
  return color.bold(clip(h.trimEnd(), w));
}

function rowLine(r: ScreenRow, c: Cols, selected: boolean, w: number): string {
  const prefix = rowPrefix(r);
  const room = c.sess - width(prefix);
  const marker = r.marker ? ` (${r.marker})` : '';
  const name = width(r.name) + width(marker) > room ? truncate(r.name, Math.max(1, room - width(marker))) : r.name;
  const plain = !!r.deleting;
  const nameCell = padEnd(`${name}${marker}`, room);
  const sess = prefix + (selected && !plain ? color.bold(nameCell) : nameCell);
  const status = padEnd(r.status, c.status);
  const where = padEnd(whereText(r, !plain), c.where);
  const gutter = selected ? (plain ? '> ' : `${color.cyan(color.bold('>'))} `) : '  ';
  const ctx = padStart(formatCtx(r.ctx), c.ctx);
  const wait = padStart(formatWaiting(r.waiting), c.wait);
  const statusCell = plain ? status : toneColor[r.tone](status);
  const line = `${gutter}${sess}${GAP}${statusCell}${GAP}${where}${GAP}${ctx}${GAP}${wait}`;
  const out = clip(line, w);
  return plain ? color.dim(out) : out;
}

function annotationLine(r: ScreenRow, text: string, w: number): string {
  const prefix = `  ${annotationPrefix(r)}`;
  const room = Math.max(1, w - width(prefix));
  const t = truncate(text, room);
  if (r.deleting) return color.dim(prefix + t);
  return prefix + color.gray(t);
}

export function headingLine(title: string, w: number): string {
  const head = `── ${title} `;
  const rest = Math.max(0, w - width(head));
  if (width(head) > w) return color.bold(truncate(head, w));
  return `${color.gray('── ')}${color.bold(title)} ${color.gray('─'.repeat(rest))}`;
}

/** 外から来た文字列の、改行とタブを空白にし、ほかの制御文字(ESC など)を除く。描画が崩れないように。 */
export function clean(s: string): string {
  let out = '';
  for (const ch of oneLine(s)) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c < 0xa0)) out += ch;
  }
  return out;
}

const cleanRow = (r: ScreenRow): ScreenRow => ({
  ...r,
  name: clean(r.name),
  line: r.line === undefined ? undefined : clean(r.line),
  running: r.running?.map(clean),
  done: r.done?.map(clean),
  note: r.note === undefined ? undefined : clean(r.note),
  where: {
    ...r.where,
    repo: r.where.repo === undefined ? undefined : clean(r.where.repo),
    sub: r.where.sub === undefined ? undefined : clean(r.where.sub),
    branch: r.where.branch === undefined ? undefined : clean(r.where.branch),
  },
});

/** 画面の行の配列を組み立てる。どの行も端末の幅に収め、行数は端末の高さを超えない。 */
export function render(raw: Screen): string[] {
  const s: Screen = {...raw, groups: raw.groups.map(g => ({...g, title: clean(g.title), rows: g.rows.map(cleanRow)}))};
  const w = Math.max(1, s.width);
  const h = Math.max(1, s.height);
  const bottom: string[] = [];
  if (s.panel && s.panel.length > 0) bottom.push('', ...s.panel.map(l => clip(l, w)));
  if (s.notice && s.notice.length > 0) bottom.push('', ...s.notice.map(l => clip(l, w)));
  const footer: string[] = [];
  if (s.usage) footer.push(clip(s.usage, w));
  footer.push(clip(s.keys ?? '', w));

  const top: string[] = [];
  if (s.message !== undefined || s.groups.every(g => g.rows.length === 0)) {
    top.push(clip(s.message ?? 'No sessions.', w));
  } else {
    const c = columns(s);
    top.push(header(c, w));
    const body: string[] = [];
    let cursorBlock: [number, number] = [0, 0];
    const rowIndex: string[] = [];
    s.groups.forEach((g, gi) => {
      if (g.rows.length === 0) return;
      if (gi > 0 && body.length > 0) body.push('');
      body.push(headingLine(g.title, w));
      for (const r of g.rows) {
        const start = body.length;
        const selected = r.sid === s.cursor;
        body.push(rowLine(r, c, selected, w));
        rowIndex.push(r.sid);
        const inline = s.inline?.sid === r.sid ? s.inline.lines : undefined;
        for (const a of annotations(r)) {
          if (inline && a.kind === 'note') continue;
          body.push(annotationLine(r, a.text, w));
        }
        if (inline) for (const l of inline) body.push(clip(`  ${annotationPrefix(r)}${l}`, w));
        if (selected) cursorBlock = [start, body.length];
      }
    });
    const fixed = 1 + bottom.length + footer.length;
    let avail = Math.max(1, h - fixed);
    let pos: string | undefined;
    if (body.length > avail) {
      avail = Math.max(1, avail - 1);
      const idx = s.cursor ? rowIndex.indexOf(s.cursor) + 1 : 0;
      pos = `${idx}/${rowIndex.length}`;
    }
    let start = 0;
    if (body.length > avail) {
      const [b0, b1] = cursorBlock;
      const blockLen = b1 - b0;
      start = blockLen >= avail ? b0 : b0 - Math.floor((avail - blockLen) / 2);
      start = Math.max(0, Math.min(start, body.length - avail));
      // 入力欄は最後の行まで窓に入れる
      if (s.inline && b1 > start + avail) start = Math.max(0, b1 - avail);
    }
    top.push(...body.slice(start, start + avail));
    if (pos) top.push(pos);
  }

  // 下の欄を最下部に寄せる。収まらなければ下から削る(ヘッダは押し出さない)
  let lines = [...top, ...bottom];
  const room = h - footer.length;
  if (lines.length > room) lines = lines.slice(0, Math.max(1, room));
  while (lines.length < room) lines.push('');
  lines.push(...footer);
  return lines.slice(0, h);
}

/** 画面全体を1回の書き込みにする(同期出力、上書き、行末と残りを消す)。 */
export function frame(lines: readonly string[]): string {
  return `\x1b[?2026h\x1b[H${lines.map(l => `${l}\x1b[K`).join('\r\n')}\x1b[J\x1b[?2026l`;
}

export interface MenuItem {
  label: string;
  /** 選べない行(薄く出す)。 */
  disabled?: boolean;
}

/**
 * 一覧の下に出すメニュー(題、入力、候補、案内)。候補が多いときは、選んだ候補が見える窓を出す。
 */
export function menuLines(opts: {
  title: string;
  input?: string;
  items: MenuItem[];
  selected: number;
  hint: string;
  maxItems: number;
  width: number;
}): string[] {
  const out: string[] = [];
  out.push(clip(opts.input === undefined ? opts.title : `${opts.title} ${opts.input}█`, opts.width));
  const n = opts.items.length;
  const room = Math.max(1, opts.maxItems);
  let start = 0;
  if (n > room) start = Math.max(0, Math.min(opts.selected - Math.floor(room / 2), n - room));
  const shown = opts.items.slice(start, start + room);
  shown.forEach((it, i) => {
    const idx = start + i;
    const sel = idx === opts.selected;
    const line = clip(`${sel ? '> ' : '  '}${it.label}`, opts.width);
    out.push(it.disabled ? color.gray(line) : sel ? color.bold(line) : line);
  });
  if (n > room) out.push(color.gray(`${opts.selected + 1}/${n}`));
  out.push(color.gray(clip(opts.hint, opts.width)));
  return out;
}
