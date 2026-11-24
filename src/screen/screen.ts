import {color, oneLine, padEnd, padStart, truncate, width} from '../../lib/text/text.js';
import type {Screen, ScreenRow, Side, Tone} from './types.js';

// 一覧の画面を組み立てる(PRODUCT.md「一覧の表示」「リポジトリの区切りと並び」)。外部に触れない純粋な関数。

const NAME_MAX = 48;
const GAP = '  ';

export function formatAge(ms: number | undefined): string {
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

/** 注記の文字列(`◎ Goal`、一言、`⚙`、`↳ メモ` の順)。 */
export function annotations(r: ScreenRow): {kind: 'goal' | 'line' | 'running' | 'note'; text: string}[] {
  const out: {kind: 'goal' | 'line' | 'running' | 'note'; text: string}[] = [];
  if (r.goal) out.push({kind: 'goal', text: `◎ ${oneLine(r.goal)}`});
  if (r.line) out.push({kind: 'line', text: oneLine(r.line)});
  if (r.running && r.running.length > 0) out.push({kind: 'running', text: `⚙ ${r.running.map(oneLine).join(' · ')}`});
  if (r.note) out.push({kind: 'note', text: `↳ ${oneLine(r.note)}`});
  return out;
}

interface Cols {
  sess: number;
  status: number;
  where: number;
  ctx: number;
  age: number;
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
  // 見出しより広く取り、CTX との間を空ける(利用者と合意した画面の幅。サイクル8までの WAITING の列と同じ)
  const age = 7;
  const cols = {sess, status, where, ctx, age};
  const total = () => 2 + cols.sess + cols.status + cols.where + cols.ctx + cols.age + GAP.length * 4;
  // 端末の幅が足りないときは WHERE から詰める
  if (total() > s.width) cols.where = Math.max(width('WHERE'), cols.where - (total() - s.width));
  if (total() > s.width) cols.sess = Math.max(width('SESSION') + 3, cols.sess - (total() - s.width));
  return cols;
}

function clip(line: string, w: number): string {
  return width(line) > w ? truncate(line, w) : line;
}

const KEYS_SEP = ' · ';

/**
 * キーの説明を幅 `w` に収める(PRODUCT.md「一覧の表示」)。収まれば1行。収まらなければ区切り(` · `)で折り、行の末尾にも
 * 次の行の頭にも区切りの記号を置かない。1つの項目だけで幅を超える行は切る。`max` 行を超える分は、最後の行に続けて切る
 * (端末の高さが小さいときに、一覧の行を押し出さないため)。
 */
export function keyLines(keys: string, w: number, max = Number.POSITIVE_INFINITY): string[] {
  if (width(keys) <= w) return [keys];
  const items = keys.split(KEYS_SEP);
  const out: string[] = [];
  let line = '';
  for (const [i, item] of items.entries()) {
    if (line !== '' && width(line) + width(KEYS_SEP) + width(item) <= w) {
      line += KEYS_SEP + item;
      continue;
    }
    if (line !== '') out.push(line);
    line = item;
    if (out.length >= max - 1) {
      line = items.slice(i).join(KEYS_SEP);
      break;
    }
  }
  out.push(line);
  return out.map(l => clip(l, w));
}

function header(c: Cols, w: number): string {
  const h = `  ${padEnd('SESSION', c.sess)}${GAP}${padEnd('STATUS', c.status)}${GAP}${padEnd('WHERE', c.where)}${GAP}${padStart('CTX', c.ctx)}${GAP}${padStart('AGE', c.age)}`;
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
  const age = padStart(formatAge(r.age), c.age);
  const statusCell = plain ? status : toneColor[r.tone](status);
  const line = `${gutter}${sess}${GAP}${statusCell}${GAP}${where}${GAP}${ctx}${GAP}${age}`;
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
  goal: r.goal === undefined ? undefined : clean(r.goal),
  line: r.line === undefined ? undefined : clean(r.line),
  running: r.running?.map(clean),
  note: r.note === undefined ? undefined : clean(r.note),
  where: {
    ...r.where,
    repo: r.where.repo === undefined ? undefined : clean(r.where.repo),
    sub: r.where.sub === undefined ? undefined : clean(r.where.sub),
    branch: r.where.branch === undefined ? undefined : clean(r.where.branch),
  },
});

/** 右の欄の幅。 */
export const SIDE_WIDTH = 46;
/** 右の欄を出す端末の幅の下限(一覧に 71 桁を残す)。足りなければ右の欄を出さない。 */
export const SIDE_MIN_COLS = 120;
const SIDE_GAP = ' │ ';
/** 右の欄に並べるリンクの数。残りは数だけ出す。 */
export const SIDE_LINKS = 5;
const LABEL_W = 10;
const WORD_CHAR = /^[!-~]$/;
const NO_LINE_START = '。、，．）」』】〉》!?！？:;：；.,)]}';

/**
 * 表示幅 `w` で折り返す。英数字の語の途中では折らず、語の頭(空白の後ろか、全角の字の後ろ)で折る。
 * 日本語のように空白のない文は字の境で折る。
 */
export function wrap(text: string, w: number): string[] {
  const seg = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
  const out: string[] = [];
  let line = '';
  let lw = 0;
  for (const {segment: g} of seg.segment(text)) {
    const gw = width(g);
    if (lw + gw > w && line !== '') {
      // 行末に続く英数字の語(次の字も英数字なら、語の途中で折ることになる)
      const word = WORD_CHAR.test(g) ? (/[!-~]+$/.exec(line)?.[0] ?? '') : '';
      if (word && word.length < line.length && width(word) < w / 2) {
        out.push(line.slice(0, line.length - word.length));
        line = word;
      } else if (NO_LINE_START.includes(g) && [...seg.segment(line)].length > 1) {
        // 句読点と閉じ括弧を行の頭に置かない(前の1字と一緒に次の行へ送る)
        const parts = [...seg.segment(line)].map(x => x.segment);
        const last = parts.pop() ?? '';
        out.push(parts.join(''));
        line = last;
      } else {
        out.push(line);
        line = '';
      }
      lw = width(line);
      if (g === ' ' && line === '') continue;
    }
    line += g;
    lw += gw;
  }
  if (line !== '' || out.length === 0) out.push(line);
  return out.map(l => l.trimEnd());
}

/** 埋め込みのリンク(OSC 8)にしてよい URL。制御文字と空白を含まない http(s) のもの。 */
const LINKABLE = /^https?:\/\/[!-~\u00a0-\u{10ffff}]+$/u;

/**
 * `text` を、`href` を開く埋め込みのリンク(OSC 8)で囲む。`href` が http(s) の URL でなければ、そのまま返す。
 * 幅は数え終えた文字列に付ける(付けたあとに幅を数えたり切ったりしない)。外側の端末に送るかは tmux が決める
 * (サーバの `terminal-features` の `hyperlinks`。DESIGN.md「一覧と作業台の仕組み」)。
 */
export function hyperlink(href: string, text: string): string {
  if (!LINKABLE.test(href)) return text;
  return `\x1b]8;;${href}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** 右の欄の行(題、ダイジェスト、会話リンク)。`rows` を超える分は切り、最後の行を `…` にする。 */
export function sideLines(side: Side, w: number, rows: number): string[] {
  const out: string[] = [color.bold(truncate(clean(side.title), w)), ''];
  const field = (label: string, value: string) => {
    const v = wrap(clean(value) || '-', w - LABEL_W);
    v.forEach((l, i) => {
      out.push(`${i === 0 ? color.bold(padEnd(label, LABEL_W)) : ' '.repeat(LABEL_W)}${l}`);
    });
  };
  if (side.digest) {
    field('Goal', side.digest.goal);
    field('Progress', side.digest.progress);
    field('Next', side.digest.next);
  } else {
    const why = side.off ?? 'No digest yet. Digests come from sessions started with n, when a turn ends.';
    for (const l of wrap(clean(why), w)) out.push(color.gray(l));
  }
  if (side.links.length > 0) {
    out.push('', color.bold('Links'));
    for (const l of side.links.slice(0, SIDE_LINKS))
      out.push(`  ${hyperlink(l.href, truncate(clean(l.label), w - 2))}`);
    if (side.links.length > SIDE_LINKS) out.push(color.gray(`  +${side.links.length - SIDE_LINKS} more`));
  }
  if (out.length > rows) {
    const cut = out.slice(0, Math.max(0, rows - 1));
    if (rows > 0) cut.push(color.gray('…'));
    return cut;
  }
  return out;
}

/**
 * 画面の行の配列を組み立てる。どの行も端末の幅に収め、行数は端末の高さを超えない。
 * 右の欄があり、端末の幅が足りるときは、一覧を狭めて右に欄を並べる。最下部の欄(Usage、キーの説明)は全幅のまま。
 * メモの入力欄と、一覧の下の入力欄・メニュー・知らせは、左の幅に収まらなければ全幅で出し、右の欄はその上で止める
 * (確認の問いの `[y/N]` のような末尾を切らないため)。
 */
export function render(raw: Screen): string[] {
  const side = raw.side;
  if (!side || raw.width < SIDE_MIN_COLS || raw.message !== undefined) return layout(raw).lines;
  const leftW = raw.width - SIDE_WIDTH - SIDE_GAP.length;
  const {lines: left, blocks, foot} = layout({...raw, width: leftW}, raw.width);
  const room = left.length - Math.min(left.length, foot);
  const wide = blocks.find(([a, b]) => left.slice(a, b).some(l => width(l) > leftW));
  const stop = Math.min(room, wide ? wide[0] : room);
  const sl = sideLines(side, SIDE_WIDTH, stop);
  return left.map((l, i) => (i < stop ? `${padEnd(l, leftW)}${color.gray(SIDE_GAP)}${sl[i] ?? ''}` : l));
}

/**
 * 一覧を `raw.width` 桁で組み立てる。メモの入力欄、一覧の下の欄、最下部の欄(Usage、キーの説明)は `full` 桁で組み立てる。
 * `blocks` は、メモの入力欄と一覧の下の欄(入力欄・メニュー・知らせ。前の空行を含む)の行の範囲。`foot` は最下部の欄の行数。
 */
type Layout = {lines: string[]; blocks: [number, number][]; foot: number};

function layout(raw: Screen, full = raw.width): Layout {
  const s: Screen = {...raw, groups: raw.groups.map(g => ({...g, title: clean(g.title), rows: g.rows.map(cleanRow)}))};
  const fw = Math.max(1, full);
  const h = Math.max(1, s.height);
  const usage = s.usage ? [clip(s.usage, fw)] : [];
  // キーの説明は、ヘッダと一覧の1行を残せる行数まで折り返す
  const wrapped = keyLines(s.keys ?? '', fw, Math.max(1, h - usage.length - 2));
  // 隠すとき(メニューや入力欄を開いている間)は、同じ行数を空けて Usage の位置を変えない。
  // どちらのときも、一覧の下の欄(入力欄・メニュー・知らせ)かメモの入力欄が収まらない高さでは、行数を1行まで減らして
  // 中身に譲る(1行は、折り返す前の最下部と同じ形)。キーの説明は、減らした分を最後の行に続けて切る
  for (let n = wrapped.length; ; n--) {
    const keys = s.keysHidden
      ? Array<string>(n).fill('')
      : n === wrapped.length
        ? wrapped
        : keyLines(s.keys ?? '', fw, n);
    const r = layoutWith(s, fw, h, [...usage, ...keys]);
    if (r.fits || n <= 1) return r.out;
  }
}

/**
 * 最下部の欄を `footer` にして組み立てる。`fits` は、一覧の下の欄を切らず、メモの入力欄を開いていればその行の塊が
 * 窓に収まったか。
 */
function layoutWith(s: Screen, fw: number, h: number, footer: string[]): {out: Layout; fits: boolean} {
  const w = Math.max(1, s.width);
  const bottom: string[] = [];
  if (s.panel && s.panel.length > 0) bottom.push('', ...s.panel.map(l => clip(l, fw)));
  if (s.notice && s.notice.length > 0) bottom.push('', ...s.notice.map(l => clip(l, fw)));
  let fits = true;

  const top: string[] = [];
  const blocks: [number, number][] = [];
  if (s.message !== undefined || s.groups.every(g => g.rows.length === 0)) {
    top.push(clip(s.message ?? 'No sessions.', w));
  } else {
    const c = columns(s);
    top.push(header(c, w));
    const body: string[] = [];
    // 選んだ行の塊(行、注記、入力欄)。窓には必ず入れる
    let block: [number, number] = [0, 0];
    // 各行を見せる役の、選べる行。起動された行は選べないので、選べる行のどれかに付けて一緒に見せる。
    // こうしないと窓の外に残って見る手段がなくなる。区切りの中では直前の選べる行に、区切りの頭は
    // その区切りの最初の選べる行に、選べる行のない区切りは直前の区切りの最後の選べる行
    // (なければ次の区切りの最初の選べる行)に付ける
    const owner: (string | undefined)[] = [];
    type Section = {from: number; first?: string; last?: string};
    const sections: Section[] = [];
    // 選べる行(起動された行は選べない)。<通し番号>/<総数> もこれで数える
    const rowIndex: string[] = [];
    // メモの入力欄の行の範囲(body の中)
    let inlineAt: [number, number] | undefined;
    s.groups.forEach((g, gi) => {
      if (g.rows.length === 0) return;
      const sec: Section = {from: body.length};
      sections.push(sec);
      if (gi > 0 && body.length > 0) body.push('');
      body.push(headingLine(g.title, w));
      for (const r of g.rows) {
        const start = body.length;
        const selected = r.sid === s.cursor;
        // `(sub)` の印は起動された行にだけ付く(app.ts の画面の行の組み立て)
        if (r.marker !== 'sub') {
          rowIndex.push(r.sid);
          sec.first ??= r.sid;
          sec.last = r.sid;
        }
        body.push(rowLine(r, c, selected, w));
        const inline = s.inline?.sid === r.sid ? s.inline.lines : undefined;
        for (const a of annotations(r)) {
          if (inline && a.kind === 'note') continue;
          body.push(annotationLine(r, a.text, w));
        }
        if (inline) {
          inlineAt = [body.length, body.length + inline.length];
          for (const l of inline) body.push(clip(`  ${annotationPrefix(r)}${l}`, fw));
        }
        if (selected) block = [start, body.length];
        while (owner.length < body.length) owner.push(sec.last);
      }
    });
    sections.forEach((sec, i) => {
      const end = sections[i + 1]?.from ?? body.length;
      const fallback =
        sec.first ??
        sections
          .slice(0, i)
          .reverse()
          .find(x => x.last)?.last ??
        sections.slice(i + 1).find(x => x.first)?.first;
      for (let j = sec.from; j < end; j++) owner[j] ??= fallback;
    });
    // 選んだ行と、それに付く行の範囲。窓に収まるときだけ一緒に入れる
    let reach: [number, number] = block;
    if (s.cursor !== undefined) {
      const r0 = owner.indexOf(s.cursor);
      const r1 = owner.lastIndexOf(s.cursor) + 1;
      if (r0 >= 0) reach = [Math.min(r0, block[0]), Math.max(r1, block[1])];
    }
    const fixed = 1 + bottom.length + footer.length;
    let avail = Math.max(1, h - fixed);
    let pos: string | undefined;
    // 選べる行がないときは、通し番号を出さない
    if (body.length > avail && rowIndex.length > 0) {
      avail = Math.max(1, avail - 1);
      const idx = s.cursor ? rowIndex.indexOf(s.cursor) + 1 : 0;
      pos = `${idx}/${rowIndex.length}`;
    }
    let start = 0;
    if (body.length > avail) {
      const [b0, b1] = block;
      const [r0, r1] = reach;
      if (r1 - r0 <= avail) start = r0 - Math.floor((avail - (r1 - r0)) / 2);
      else if (b1 - b0 >= avail) start = b0;
      // 下に続く起動された行を優先し、余れば上(区切りの頭)も見せる
      else if (r1 > b1) start = Math.max(r0, Math.min(b0, r1 - avail));
      else start = Math.max(r0, b1 - avail);
      start = Math.max(0, Math.min(start, body.length - avail));
      // 入力欄は最後の行まで窓に入れる
      if (s.inline && b1 > start + avail) start = Math.max(0, b1 - avail);
    }
    if (s.inline && block[1] - block[0] > avail) fits = false;
    top.push(...body.slice(start, start + avail));
    if (inlineAt) {
      const a = Math.max(inlineAt[0], start);
      const b = Math.min(inlineAt[1], start + avail);
      if (a < b) blocks.push([1 + a - start, 1 + b - start]);
    }
    if (pos) top.push(pos);
  }
  if (bottom.length > 0) blocks.push([top.length, top.length + bottom.length]);

  // 下の欄を最下部に寄せる。収まらなければ下から削る(ヘッダは押し出さない)
  let lines = [...top, ...bottom];
  const room = h - footer.length;
  if (lines.length > room) {
    lines = lines.slice(0, Math.max(1, room));
    if (bottom.length > 0) fits = false;
  }
  while (lines.length < room) lines.push('');
  lines.push(...footer);
  return {out: {lines: lines.slice(0, h), blocks, foot: footer.length}, fits};
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
