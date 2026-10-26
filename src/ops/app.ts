import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {basename} from 'node:path';
import type {UsageFrame} from '../../lib/input/claude.js';
import {readAgents} from '../../lib/input/claude.js';
import {stripControl} from '../../lib/input/exec.js';
import type {Supplied} from '../../lib/input/hooks.js';
import {firstLine, leadLine} from '../../lib/input/text.js';
import {color} from '../../lib/text/text.js';
import {statusLabel, type Tier} from '../../lib/tier/classify.js';
import {focusWorkbench, splitWorkbench} from '../../lib/tmux/ghostty.js';
import {GUIDE, LIST} from '../../lib/tmux/tmux.js';
import type {Observation, ObsRow} from '../input/observe.js';
import {locate} from '../input/where.js';
import {followCursor, initialCursor} from '../model/cursor.js';
import {groupTitles, layout, stageStartsOf} from '../model/layout.js';
import {canLink, cascade, waitCandidates} from '../model/relations.js';
import type {Inputs, Layout, Row} from '../model/types.js';
import {validWaits} from '../model/waits.js';
import {clean, frame, menuLines, render} from '../screen/screen.js';
import type {Screen, ScreenRow} from '../screen/types.js';
import {emptyState, type PersistedState} from '../state/state.js';
import {filterItems} from './filter.js';
import {ATTACH_KEYS, type AttachAction, GUIDE_CREATE, isAttachAction, LIST_KEYS_HELP} from './keys.js';
import {GUIDE_OPTION, type GuideState, MAIN_TTY, NEWER, WB_TTY} from './names.js';
import type {Ports} from './ports.js';

// 一覧の状態の遷移と、外部に頼む作業(PRODUCT.md「操作」「作業台」「依存（待ち先と起動された行）」)。

const REFRESH_MS = 60_000;
const USAGE_MIN_MS = 60_000;
const ARM_MS = 2000;
// 止める操作が失敗したときの知らせと、そのあいだの削除の待ち受け(文言を読む時間を取る)
const STOP_FAILED_MS = 8000;
const GUARD_MS = 2000;
const CLAUDE_SESSION = /^[0-9a-f]{8}$/;

export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

interface DirItem {
  label: string;
  path?: string;
  other?: boolean;
}

type Mode =
  | {k: 'list'}
  | {k: 'note'; sid: string; text: string}
  | {k: 'wait'; waiter: string; filter: string; sel: number}
  | {k: 'dir'; filter: string; sel: number; items: DirItem[]; waitFor?: string}
  | {k: 'other'; text: string; error?: string; waitFor?: string; items: DirItem[]}
  | {k: 'model'; sel: number; dir: string; waitFor?: string; items: DirItem[]}
  | {k: 'modelInput'; text: string; dir: string; waitFor?: string; items: DirItem[]}
  | {k: 'starting'; dir: string; model?: string; since: number}
  | {k: 'output'; lines: string[]};

interface Notice {
  text: string;
  until?: number;
}

const tierOf = (t: Tier | null): Tier => t ?? 'review';

export class App {
  private persisted: PersistedState = emptyState();
  private rows = new Map<string, ObsRow>();
  private spawner = new Map<string, string>();
  private supplied = new Map<string, Supplied>();
  private error?: string;
  private lastAt?: number;
  private since = new Map<string, {tier: Tier; observed?: number}>();
  /** 待ちの段を出たのを見た時刻(レビュー待ちに戻った待ち元だけ)。 */
  private leftWait = new Map<string, number>();
  private waitingMs = new Map<string, number | undefined>();
  private lay: Layout = {groups: [], order: [], parent: new Map(), tier: new Map()};
  private cursor?: string;
  private mode: Mode = {k: 'list'};
  private confirms: {prompt: string; def: boolean; resolve: (yes: boolean) => void}[] = [];
  private notices: Notice[] = [];
  private refreshing = false;
  private refreshQueued = false;
  private manualPending = false;
  private manualQueued = false;
  private refreshTimer?: NodeJS.Timeout;
  private armed?: {sid: string; until: number};
  private guard?: {until: number; name: string};
  private stopping = new Map<string, Promise<void>>();
  private deleting = new Set<string>();
  private pendingLinks: {waiter: string; id: string}[] = [];
  private running = new Map<string, string[]>();
  private usage?: UsageFrame[];
  private usageStarted = 0;
  private usageInflight = false;
  private mainSession?: string;
  private pendingReturn?: string;
  private wbTty?: string;
  private mainTty?: string;
  private newer?: string;
  private queue: Promise<void> = Promise.resolve();
  private drawScheduled = false;
  private followTimer?: NodeJS.Timeout;
  private followChain: Promise<void> = Promise.resolve();
  private lastGuide?: string;
  private closedWorkbench = new Set<string>();
  private paste?: string;
  private quitting = false;
  private initialized = false;

  constructor(private readonly p: Ports) {}

  // ---- 起動 ----

  async start(): Promise<void> {
    this.persisted = this.p.stateFile.load();
    this.p.hooks.onEvent((sid, event) => this.onHook(sid, event));
    await this.cleanupLeftovers();
    await this.refresh({initial: true});
    this.initialized = true;
    this.fetchUsage(true);
    // 起動中に届いた知らせは保留してあるので、ここで1回読む
    this.signal();
    await this.queue;
  }

  /** 前の tmux サーバに残っていたもの(異常終了のあと)。動いているものがある作業台だけ、引き継ぐかを聞く。 */
  private async cleanupLeftovers(): Promise<void> {
    const sessions = await this.p.tmux.sessions();
    const running = await this.p.tmux.running();
    const keep: string[] = [];
    for (const s of sessions) {
      if (s === LIST || s === GUIDE) continue;
      if (CLAUDE_SESSION.test(s) || s.startsWith('trust-')) await this.p.tmux.killSession(s);
      else if (s.startsWith('sh-')) {
        if ((running.get(s.slice(3)) ?? []).length > 0) keep.push(s);
        else await this.killSafely(s);
      }
    }
    if (keep.length === 0) return;
    const list = keep.map(s => `${s.slice(3)}: ${(running.get(s.slice(3)) ?? []).join(', ')}`);
    const n = keep.length;
    const yes = await this.ask(
      `${n} ${n === 1 ? 'command is' : 'commands are'} still running from a previous whatnext: ${list.join(', ')}. Keep them? [Y/n]`,
      true,
    );
    if (!yes) for (const s of keep) await this.killSafely(s);
  }

  /** セッションを畳む。クライアントが映していれば、先に別のセッションへ切り替える(`detach-on-destroy on` なので、先に畳むとクライアントごと離れる)。 */
  private async killSafely(session: string): Promise<void> {
    const t = this.p.tmux;
    const [clients, main, wb] = await Promise.all([t.clients(), t.option(MAIN_TTY), t.option(WB_TTY)]);
    for (const c of clients) {
      if (c.session !== session) continue;
      if (c.tty === wb) await t.switchClient(c.tty, GUIDE);
      else if (c.tty === main) await t.switchClient(c.tty, LIST);
    }
    await t.killSession(session);
  }

  // ---- 更新 ----

  async refresh(opts: {initial?: boolean; manual?: boolean} = {}): Promise<void> {
    if (this.refreshing) {
      // 更新の途中で押された更新キーの Refreshed. は、押したあとに始まる更新が終わってから出す
      if (opts.manual) this.manualQueued = true;
      this.refreshQueued = true;
      return;
    }
    if (opts.manual) this.manualPending = true;
    this.refreshing = true;
    this.draw();
    try {
      const obs = await this.p.observer.observe();
      await this.apply(obs, !!opts.initial);
    } catch (e) {
      this.p.log(`refresh failed: ${e instanceof Error ? e.stack : String(e)}`);
    } finally {
      this.refreshing = false;
      if (this.manualPending) {
        this.manualPending = false;
        this.notify('Refreshed.', 2000);
      }
      this.scheduleRefresh();
      this.draw();
      this.follow();
    }
    if (this.refreshQueued) {
      this.refreshQueued = false;
      const manual = this.manualQueued;
      this.manualQueued = false;
      await this.refresh({manual});
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_MS);
  }

  private async apply(obs: Observation, initial: boolean): Promise<void> {
    if (!obs.ok) {
      // 前の並びとカーソルは残す(次に読めた更新で、消えた行の移り先と Ctrl+X の守りに使う)。
      // エラーを出している間は、行への操作を受け付けない
      this.error = `Could not read claude agents --json: ${clean(obs.error)}`;
      return;
    }
    // 外への問い合わせを先に済ませ、そのあとで行と並びを同じ時点の組として差し替える(途中で描いても、
    // 消えた行を古い並びから引かないように)
    await this.p.locations.refresh(obs.rows.filter(r => r.tier !== null).map(r => r.cwd));
    const running = await this.p.tmux.running();
    this.error = undefined;
    const prevLayout = this.lay;
    const prevAt = this.lastAt;
    this.lastAt = obs.at;
    const present = new Set(obs.rows.map(r => r.sid));
    // --json から消えたセッションの関係、メモ、時刻を外す(ファイルにはそのまま書く。木にならない関係を整理するのは、
    // 利用者がメモか待ち先を変えたときだけ。DESIGN.md「状態のファイルに書くもの」)
    let linked = false;
    for (const m of [this.persisted.notes, this.persisted.seen] as Map<string, unknown>[]) {
      for (const k of [...m.keys()]) if (!present.has(k)) m.delete(k);
    }
    for (const [w, ts] of [...this.persisted.waits]) {
      if (!present.has(w)) {
        this.persisted.waits.delete(w);
        continue;
      }
      const kept = ts.filter(t => present.has(t));
      if (kept.length !== ts.length) {
        if (kept.length === 0) this.persisted.waits.delete(w);
        else this.persisted.waits.set(w, kept);
      }
    }
    for (const s of [...this.deleting]) if (!present.has(s)) this.deleting.delete(s);
    this.rows = new Map(obs.rows.map(r => [r.sid, {...r, name: clean(r.name)}]));
    this.spawner = obs.spawner;
    this.supplied = obs.supplied;
    for (const r of obs.rows) {
      if (r.tier !== null && !this.persisted.seen.has(r.sid)) this.persisted.seen.set(r.sid, {first: obs.at});
    }
    // f の New session で起動したセッションを、--json に現れた時点で結ぶ
    for (const pl of [...this.pendingLinks]) {
      const row = obs.rows.find(r => r.id === pl.id);
      if (!row) continue;
      this.pendingLinks = this.pendingLinks.filter(x => x !== pl);
      if (present.has(pl.waiter) && canLink(this.inputs(), pl.waiter, row.sid)) {
        this.link(pl.waiter, row.sid);
        linked = true;
      }
    }
    this.running = running;
    // 待機時間(悲観的に数え、更新の間は止める)
    const nextSince = new Map<string, {tier: Tier; observed?: number}>();
    const own = new Map<string, number | undefined>();
    for (const r of obs.rows) {
      if (r.tier === null) continue;
      const before = this.since.get(r.sid);
      const observed =
        before && before.tier === r.tier ? before.observed : initial || prevAt === undefined ? undefined : prevAt;
      nextSince.set(r.sid, {tier: r.tier, observed});
      const sup = obs.supplied.get(r.sid) ?? {};
      const hook = r.tier === 'working' ? sup.prompt?.at : r.tier === 'stopped' ? undefined : sup.haltAt;
      own.set(r.sid, hook ?? observed ?? (r.tier === 'stopped' ? sup.haltAt : undefined));
    }
    this.since = nextSince;
    // 更新の間に待ちが明けた待ち元は、前回の更新時刻から自分の段にいたとみなす(悲観的に数える)
    this.relayout(initial ? null : (prevAt ?? null));
    // 待ちが明けた待ち元は、待ちが明けた時刻から数える
    this.waitingMs.clear();
    for (const [sid, at] of stageStartsOf(this.inputs(), own, this.leftWait)) {
      this.waitingMs.set(sid, at === undefined ? undefined : Math.max(0, obs.at - at));
    }
    // カーソル
    if (initial || this.cursor === undefined) {
      this.cursor = initialCursor(this.lay, this.persisted.seen);
    } else if (!this.lay.order.includes(this.cursor)) {
      const goneName = prevLayout.order.includes(this.cursor) ? this.nameOfPrev(this.cursor) : undefined;
      const next = followCursor(prevLayout, this.cursor, this.lay);
      if (next !== this.cursor && goneName) this.guard = {until: this.p.now() + GUARD_MS, name: goneName};
      this.cursor = next;
      if (this.armed) this.armed = undefined;
    }
    // 起動した直後のセッションから戻ったときは、その行が観測に現れた更新で選ぶ
    if (this.pendingCursorId) {
      const r = obs.rows.find(x => x.id === this.pendingCursorId && x.tier !== null);
      if (r) {
        this.pendingCursorId = undefined;
        this.stampAttached(r.sid);
        this.cursor = r.sid;
        this.guard = undefined;
        this.relayout();
      }
    }
    this.save(linked);
    void this.updateSummaries();
    this.p.prs.refresh(
      obs.rows
        .filter(r => r.tier !== null)
        .flatMap(r => {
          const loc = this.p.locations.get(r.cwd);
          return loc?.repo && loc.branch ? [{checkout: loc.checkout, branch: loc.branch}] : [];
        }),
      () => this.draw(),
    );
  }

  private nameCache = new Map<string, string>();
  private nameOfPrev(sid: string): string {
    return this.rows.get(sid)?.name ?? this.nameCache.get(sid) ?? sid.slice(0, 8);
  }

  private inputs(): Inputs {
    const rows: Row[] = [...this.rows.values()].map(r => ({
      sid: r.sid,
      id: r.id,
      kind: r.kind,
      name: r.name,
      tier: r.tier,
      group: this.p.locations.get(r.cwd)?.root ?? r.cwd,
    }));
    return {rows, waits: this.persisted.waits, spawner: this.spawner, times: this.persisted.seen};
  }

  /**
   * 並びを導き直す。待ちの段を出て自分の段(レビュー待ち)に戻った待ち元には、出たのを見た時刻(`seenAt`。
   * 分からなければ null)を付け、レビュー待ちを離れたら外す。待ち先の時刻が分からないときの、待機時間の起点の補い。
   */
  private relayout(seenAt: number | null = this.p.now()): void {
    const prev = this.lay;
    this.lay = layout(this.inputs());
    for (const r of this.rows.values()) this.nameCache.set(r.sid, r.name);
    for (const sid of [...this.leftWait.keys()]) if (this.lay.tier.get(sid) !== 'review') this.leftWait.delete(sid);
    if (seenAt === null) return;
    for (const [sid, t] of this.lay.tier) {
      if (t === 'review' && prev.tier.get(sid) === 'waiting') this.leftWait.set(sid, seenAt);
    }
  }

  private save(annotated: boolean): void {
    if (annotated) {
      // 利用者がメモか待ち先を変えたときは、木として扱える関係だけを書く
      const inp = this.inputs();
      const all = new Map(inp.rows.map(r => [r.sid, r]));
      this.persisted.waits = validWaits(this.persisted.waits, all, new Set(this.spawner.keys()));
    }
    this.p.stateFile.save(this.persisted, annotated);
  }

  private async updateSummaries(): Promise<void> {
    const sessions = new Set(await this.p.tmux.sessions());
    for (const r of this.rows.values()) {
      if (!r.id || !sessions.has(r.id)) continue;
      await this.setSummary(r);
    }
  }

  private async setSummary(r: ObsRow, force = false): Promise<void> {
    if (!r.id) return;
    const first = await this.p.transcripts.firstPrompt(r.sid, force).catch(() => undefined);
    if (first) this.firstKnown.add(r.sid);
    // 前に置いたものと同じなら tmux を呼ばない
    const text = first ? `${r.name} · ${first}` : r.name;
    if (this.summaries.get(r.id) === text) return;
    this.summaries.set(r.id, text);
    await this.p.tmux.setSummary(r.id, text);
  }

  private onHook(sid: string, event: string): void {
    // 最初の依頼がもう分かっていれば何もしない(概要の行は変わらない)
    if (event !== 'UserPromptSubmit' || this.firstKnown.has(sid)) return;
    // 最初の依頼を送ったら、更新を待たずに概要の行に出す(会話記録の行は少し遅れて書かれる)
    const id = sid.slice(0, 8);
    void (async () => {
      const sessions = await this.p.tmux.sessions();
      if (!sessions.includes(id)) return;
      const name = this.rows.get(sid)?.name ?? id;
      for (let i = 0; i < 10; i++) {
        const first = await this.p.transcripts.firstPrompt(sid, true).catch(() => undefined);
        if (first) {
          this.firstKnown.add(sid);
          this.summaries.set(id, `${name} · ${first}`);
          await this.p.tmux.setSummary(id, `${name} · ${first}`);
          return;
        }
        await sleep(1000);
      }
    })();
  }

  private fetchUsage(force = false): void {
    const now = this.p.now();
    if (this.usageInflight) return;
    if (!force && now - this.usageStarted < USAGE_MIN_MS) return;
    this.usageInflight = true;
    this.usageStarted = now;
    void this.p
      .fetchUsage()
      .then(u => {
        if (u && u.length > 0) this.usage = u;
      })
      .catch(() => {})
      .finally(() => {
        this.usageInflight = false;
        this.draw();
      });
  }

  // ---- 描画 ----

  draw(): void {
    if (this.drawScheduled) return;
    this.drawScheduled = true;
    setImmediate(() => {
      this.drawScheduled = false;
      if (this.quitting) return;
      this.p.write(frame(render(this.screen())));
    });
  }

  private notify(text: string, ms = 5000): void {
    this.notices = [{text, until: this.p.now() + ms}];
    setTimeout(() => this.draw(), ms + 20);
    this.draw();
  }

  private lineOf(r: ObsRow, tier: Tier): string | undefined {
    const s = this.supplied.get(r.sid) ?? {};
    const lead = s.lastText ? leadLine(s.lastText) : undefined;
    switch (tier) {
      case 'working':
        return s.prompt ? `→ ${firstLine(s.prompt.text) ?? s.prompt.text}` : undefined;
      case 'permission':
        return s.permission;
      case 'question':
        return s.question ?? (s.declined ? `Declined: ${s.declined}` : lead);
      case 'failed':
        return s.error ?? lead;
      default:
        return lead;
    }
  }

  private titles(): Map<string, string> {
    const roots = new Set<string>();
    // 見出しと同じく、一覧に出る行の根だけで名前を決める(見えない行の根で WHERE の名前が変わらないように)
    for (const r of this.rows.values()) if (r.tier !== null) roots.add(this.p.locations.get(r.cwd)?.root ?? r.cwd);
    return groupTitles([...roots]);
  }

  private screenRow(
    sid: string,
    group: string,
    n: Layout['groups'][number]['nodes'][number],
    titles: Map<string, string>,
  ): ScreenRow {
    const r = this.rows.get(sid) as ObsRow;
    const tier = this.lay.tier.get(sid) ?? tierOf(r.tier);
    const loc = this.p.locations.get(r.cwd);
    const root = loc?.root ?? r.cwd;
    const status = this.deleting.has(sid)
      ? 'Deleting...'
      : this.stopping.has(sid)
        ? 'Stopping...'
        : tier === 'waiting'
          ? statusLabel('waiting')
          : statusLabel(tier, r.reason);
    const pr = loc?.repo && loc.branch ? this.p.prs.get(loc.checkout, loc.branch) : undefined;
    return {
      sid,
      name: r.name,
      marker: n.spawned ? 'sub' : r.kind === 'interactive' ? 'tty' : undefined,
      status,
      tone: tier,
      where: {
        repo: root !== group ? (titles.get(root) ?? basename(root)) : undefined,
        sub: loc?.repo ? loc.sub : undefined,
        branch: loc?.branch,
        worktree: loc?.worktree,
        pr,
      },
      ctx: this.supplied.get(sid)?.ctx,
      waiting: this.waitingMs.get(sid),
      line: this.lineOf(r, tier === 'waiting' ? tierOf(r.tier) : tier),
      running: r.id ? this.running.get(r.id) : undefined,
      note: n.spawned ? undefined : this.persisted.notes.get(sid),
      deleting: this.deleting.has(sid),
      depth: n.depth,
      last: n.last,
      ancestorsLast: n.ancestorsLast,
      hasChildren: n.hasChildren,
    };
  }

  private screen(): Screen {
    const {cols, rows} = this.p.size();
    const titles = this.titles();
    const s: Screen = {
      width: cols,
      height: rows,
      cursor: this.cursor,
      groups: this.lay.groups.map(g => ({
        title: g.title,
        rows: g.nodes.filter(n => this.rows.has(n.sid)).map(n => this.screenRow(n.sid, g.root, n, titles)),
      })),
      keys: this.mode.k === 'list' && this.confirms.length === 0 ? LIST_KEYS_HELP : '',
      usage: this.usageText(),
    };
    if (this.error) s.message = this.error;
    else if (this.lay.order.length === 0)
      s.message = this.initialized ? 'No sessions to show. Press n to start one.' : 'Loading...';
    const panel = this.confirms[0] ? [this.confirms[0].prompt] : this.panel(cols, rows);
    if (this.mode.k === 'note') {
      const m = this.mode;
      const name = this.rows.get(m.sid)?.name ?? m.sid.slice(0, 8);
      s.inline = {
        sid: m.sid,
        lines: [`Note for ${name}: ${m.text}█`, color.gray('Enter confirm · Esc cancel · ^U clear')],
      };
    }
    if (this.confirms[0] || (this.mode.k !== 'note' && panel.length > 0)) s.panel = panel;
    const notice: string[] = [];
    if (this.refreshing) notice.push('refreshing...');
    const now = this.p.now();
    this.notices = this.notices.filter(n => n.until === undefined || n.until > now);
    for (const n of this.notices) notice.push(n.text);
    if (this.newer) notice.push(`whatnext ${this.p.version} is still running. Quit it to start ${this.newer}.`);
    if (notice.length > 0) s.notice = notice;
    return s;
  }

  private usageText(): string | undefined {
    if (!this.usage) return undefined;
    return this.usage
      .map(f => {
        const pct = `${f.percent}%`;
        const c = f.percent >= 80 ? color.red(pct) : f.percent >= 50 ? color.yellow(pct) : pct;
        return `${f.label} ${c}${f.resets ? ` (resets ${f.resets})` : ''}`;
      })
      .join(' · ');
  }

  private panel(cols: number, rows: number): string[] {
    const m = this.mode;
    const maxItems = Math.max(3, Math.floor(rows / 2) - 4);
    switch (m.k) {
      case 'wait': {
        const name = this.rows.get(m.waiter)?.name ?? '';
        const items = this.waitItems(m.waiter, m.filter);
        return menuLines({
          title: `${name} waits for:`,
          input: m.filter,
          items: items.map(i => ({label: i.label})),
          selected: m.sel,
          hint: 'Type to filter · Enter select · Esc close',
          maxItems,
          width: cols,
        });
      }
      case 'dir': {
        const items = this.dirItems(m);
        return menuLines({
          title: 'New session in:',
          input: m.filter,
          items: items.map(i => ({label: i.label})),
          selected: m.sel,
          hint: 'Type to filter · Enter select · Esc close',
          maxItems,
          width: cols,
        });
      }
      case 'other':
        return [
          `Directory: ${m.text}█`,
          ...(m.error ? [color.red(m.error)] : []),
          color.gray(`Enter confirm (empty: ${this.tilde(this.p.launchDir)}) · Esc back`),
        ];
      case 'model':
        return menuLines({
          title: `Model for ${this.tilde(m.dir)}:`,
          items: [{label: 'default'}, {label: 'Other...'}],
          selected: m.sel,
          hint: 'Enter select · Esc back',
          maxItems,
          width: cols,
        });
      case 'modelInput':
        return [`Model: ${m.text}█`, color.gray('Enter start · Esc back')];
      case 'starting': {
        const secs = Math.floor((this.p.now() - m.since) / 1000);
        return [
          'New session',
          `  Directory: ${this.tilde(m.dir)}`,
          `  Model: ${m.model ?? 'default'}`,
          `Starting the session... ${secs}s`,
        ];
      }
      case 'output':
        return [...m.lines, color.gray('Press any key to go back to the list.')];
      default:
        return [];
    }
  }

  // ---- メニューの中身 ----

  private waitItems(waiter: string, filter: string): {label: string; sid?: string; linked?: boolean}[] {
    const inp = this.inputs();
    const titles = this.titles();
    const cands = waitCandidates(inp, this.lay, waiter)
      .filter(c => this.rows.has(c.sid))
      .map(c => {
        const r = this.rows.get(c.sid) as ObsRow;
        const root = this.p.locations.get(r.cwd)?.root ?? r.cwd;
        const tier = this.lay.tier.get(c.sid) ?? tierOf(r.tier);
        const status = tier === 'waiting' ? statusLabel('waiting') : statusLabel(tier, r.reason);
        const tag = r.kind === 'interactive' ? ' (tty)' : '';
        return {
          label: `${c.linked ? '✓ ' : '  '}${r.name}${tag}  ${status} · ${titles.get(root) ?? basename(root)}`,
          name: r.name,
          path: root,
          sid: c.sid,
          linked: c.linked,
        };
      });
    const filtered = filter
      ? filterItems(
          cands.map(c => ({...c, label: c.name, full: c.label})),
          filter,
        ).map(c => ({label: c.full, sid: c.sid, linked: c.linked}))
      : cands;
    return [{label: 'New session'}, ...filtered];
  }

  private dirItems(m: {filter: string; items: DirItem[]}): DirItem[] {
    const filtered = filterItems(
      m.items.filter(i => !i.other),
      m.filter,
    );
    return [...filtered, {label: 'Other...', other: true}];
  }

  private tilde(p: string): string {
    return this.p.home && (p === this.p.home || p.startsWith(`${this.p.home}/`))
      ? `~${p.slice(this.p.home.length)}`
      : p;
  }

  // ---- キー ----

  onKey(str: string | undefined, key: Key | undefined): void {
    const name = key?.name;
    this.p.log(`key ${JSON.stringify({str, name, ctrl: key?.ctrl, meta: key?.meta})}`);
    if (name === 'paste-start') {
      this.paste = '';
      return;
    }
    if (name === 'paste-end') {
      const text = clean((this.paste ?? '').replace(/[\r\n]+/g, ' '));
      this.paste = undefined;
      this.typeText(text);
      return;
    }
    if (this.paste !== undefined) {
      this.paste += str ?? '';
      return;
    }
    try {
      this.handleKey(str, key ?? {});
    } catch (e) {
      this.p.log(`key failed: ${e instanceof Error ? e.stack : String(e)}`);
    }
    this.draw();
  }

  private typeText(text: string): void {
    const m = this.mode;
    if (m.k === 'note') m.text += text;
    else if (m.k === 'other' || m.k === 'modelInput') m.text += text;
    else if (m.k === 'wait' || m.k === 'dir') {
      m.filter += text;
      m.sel = this.firstMatchIndex(m);
    }
    this.draw();
  }

  private firstMatchIndex(m: Mode): number {
    if (m.k === 'wait') return m.filter && this.waitItems(m.waiter, m.filter).length > 1 ? 1 : 0;
    return 0;
  }

  private handleKey(str: string | undefined, key: Key): void {
    const m = this.mode;
    const name = key.name;
    const printable = str !== undefined && str.length > 0 && !key.ctrl && !key.meta && str >= ' ' && str !== '\x7f';
    // ctrl+q は一覧では何もしない(削除の待ち受けも取り消さない)
    if (key.ctrl && name === 'q') return;
    if (this.notices.length > 0 && m.k === 'list' && name !== 'x') this.notices = [];
    // 確認が開いていれば、まず確認に答える(画面の切り替えがあっても、確認は待ち行列に残る)
    const c = this.confirms[0];
    if (c) {
      if (str === 'y' || str === 'Y') this.answer(true);
      else if (str === 'n' || str === 'N' || name === 'escape') this.answer(false);
      else if (name === 'return') this.answer(c.def);
      return;
    }
    switch (m.k) {
      case 'starting':
        return;
      case 'output':
        this.mode = {k: 'list'};
        return;
      case 'note': {
        if (name === 'escape') this.mode = {k: 'list'};
        else if (name === 'return') this.commitNote(m.sid, m.text);
        else if (key.ctrl && name === 'u') m.text = '';
        else if (name === 'backspace') m.text = dropLast(m.text);
        else if (printable) m.text += str;
        return;
      }
      case 'wait': {
        const items = this.waitItems(m.waiter, m.filter);
        if (name === 'escape') this.mode = {k: 'list'};
        else if (name === 'up') m.sel = Math.max(0, m.sel - 1);
        else if (name === 'down') m.sel = Math.min(items.length - 1, m.sel + 1);
        else if (name === 'return') this.chooseWait(m.waiter, items[m.sel]);
        else if (name === 'backspace') {
          m.filter = dropLast(m.filter);
          m.sel = this.firstMatchIndex(m);
        } else if (printable) {
          m.filter += str;
          m.sel = this.firstMatchIndex(m);
        }
        return;
      }
      case 'dir': {
        const items = this.dirItems(m);
        if (name === 'escape') this.mode = {k: 'list'};
        else if (name === 'up') m.sel = Math.max(0, m.sel - 1);
        else if (name === 'down') m.sel = Math.min(items.length - 1, m.sel + 1);
        else if (name === 'return') {
          const it = items[m.sel];
          if (!it) return;
          if (it.other) this.mode = {k: 'other', text: m.filter, waitFor: m.waitFor, items: m.items};
          else if (it.path) this.mode = {k: 'model', sel: 0, dir: it.path, waitFor: m.waitFor, items: m.items};
        } else if (name === 'backspace') {
          m.filter = dropLast(m.filter);
          m.sel = 0;
        } else if (printable) {
          m.filter += str;
          m.sel = 0;
        }
        return;
      }
      case 'other': {
        if (name === 'escape') this.mode = {k: 'dir', filter: '', sel: 0, items: m.items, waitFor: m.waitFor};
        else if (name === 'return') {
          const dir = this.resolveDir(m.text);
          if (typeof dir === 'string') this.mode = {k: 'model', sel: 0, dir, waitFor: m.waitFor, items: m.items};
          else m.error = dir.error;
        } else if (key.ctrl && name === 'u') {
          m.text = '';
          m.error = undefined;
        } else if (name === 'backspace') {
          m.text = dropLast(m.text);
          m.error = undefined;
        } else if (printable) {
          m.text += str;
          m.error = undefined;
        }
        return;
      }
      case 'model': {
        if (name === 'escape') this.mode = {k: 'dir', filter: '', sel: 0, items: m.items, waitFor: m.waitFor};
        else if (name === 'up' || name === 'down') m.sel = m.sel === 0 ? 1 : 0;
        else if (name === 'return') {
          if (m.sel === 0) void this.startSession(m.dir, undefined, m.waitFor);
          else this.mode = {k: 'modelInput', text: '', dir: m.dir, waitFor: m.waitFor, items: m.items};
        }
        return;
      }
      case 'modelInput': {
        if (name === 'escape') this.mode = {k: 'model', sel: 1, dir: m.dir, waitFor: m.waitFor, items: m.items};
        else if (name === 'return') {
          const model = m.text.trim();
          if (model) void this.startSession(m.dir, model, m.waitFor);
        } else if (key.ctrl && name === 'u') m.text = '';
        else if (name === 'backspace') m.text = dropLast(m.text);
        else if (printable) m.text += str;
        return;
      }
      case 'list':
        this.listKey(str, key);
        return;
    }
  }

  private listKey(str: string | undefined, key: Key): void {
    const name = key.name;
    const isCtrlX = key.ctrl && name === 'x';
    if (this.armed && !isCtrlX) {
      this.armed = undefined;
      this.notices = [];
      if (name === 'escape') return;
    }
    // --json を読めずエラーだけを出している間は、画面に出ていない行への操作を受け付けない
    if (this.error && str !== 'q' && str !== 'r' && str !== 'n') return;
    const order = this.lay.order;
    const i = this.cursor ? order.indexOf(this.cursor) : -1;
    if (name === 'up') {
      if (i > 0) this.moveCursor(order[i - 1]);
      return;
    }
    if (name === 'down') {
      if (i >= 0 && i < order.length - 1) this.moveCursor(order[i + 1]);
      else if (i < 0 && order.length > 0) this.moveCursor(order[0]);
      return;
    }
    if (isCtrlX) {
      void this.ctrlX();
      return;
    }
    const sid = this.cursor;
    const row = sid ? this.rows.get(sid) : undefined;
    if (str === 'q') {
      void this.quit();
      return;
    }
    if (str === 'r') {
      this.fetchUsage();
      void this.refresh({manual: true});
      return;
    }
    if (str === 'n') {
      this.openNew();
      return;
    }
    if (!row || !sid) return;
    const busy = this.deleting.has(sid);
    if (name === 'return') {
      if (!busy) void this.enter(row);
      return;
    }
    if (busy && (str === 'e' || str === 'f' || str === 'w' || str === 'v')) return;
    if (str === 'e') this.openNote(sid);
    else if (str === 'f') this.openWait(sid);
    else if (str === 'w') void this.createWorkbench(sid, {from: 'list'});
    else if (str === 'v') void this.openVsCode(sid, {from: 'list'});
  }

  private moveCursor(sid: string): void {
    this.cursor = sid;
    this.guard = undefined;
    this.follow();
  }

  private isSpawned(sid: string): boolean {
    return this.spawner.has(sid);
  }

  // ---- メモ ----

  private openNote(sid: string): void {
    const r = this.rows.get(sid);
    if (!r) return;
    if (this.isSpawned(sid)) {
      this.notify(`${r.name} was started by another session. It can't have a note.`);
      return;
    }
    this.mode = {k: 'note', sid, text: this.persisted.notes.get(sid) ?? ''};
  }

  private commitNote(sid: string, text: string): void {
    const t = text.trim();
    const before = this.persisted.notes.get(sid);
    this.mode = {k: 'list'};
    if (t) this.persisted.notes.set(sid, t);
    else this.persisted.notes.delete(sid);
    const name = this.rows.get(sid)?.name ?? sid.slice(0, 8);
    if (!t && before) this.notify(`Removed the note on ${name}.`);
    else if (t && before && t !== before) this.notify(`Updated the note on ${name}.`);
    else if (t && !before) this.notify(`Added a note to ${name}.`);
    this.save(true);
  }

  // ---- 待ち先 ----

  private openWait(sid: string): void {
    const r = this.rows.get(sid);
    if (!r) return;
    if (this.isSpawned(sid)) {
      this.notify(`${r.name} was started by another session. It can't wait for other sessions.`);
      return;
    }
    if (r.kind !== 'background') {
      this.notify(`${r.name} is an interactive session. It can't wait for other sessions.`);
      return;
    }
    this.mode = {k: 'wait', waiter: sid, filter: '', sel: 0};
  }

  private chooseWait(waiter: string, item: {sid?: string; linked?: boolean} | undefined): void {
    if (!item) return;
    this.mode = {k: 'list'};
    if (!item.sid) {
      this.openNew(waiter);
      return;
    }
    const wname = this.rows.get(waiter)?.name ?? '';
    const tname = this.rows.get(item.sid)?.name ?? '';
    if (item.linked) {
      const ts = (this.persisted.waits.get(waiter) ?? []).filter(t => t !== item.sid);
      if (ts.length > 0) this.persisted.waits.set(waiter, ts);
      else this.persisted.waits.delete(waiter);
      this.notify(`${wname} no longer waits for ${tname}.`);
    } else {
      if (!canLink(this.inputs(), waiter, item.sid)) return;
      this.link(waiter, item.sid);
      this.notify(`${wname} now waits for ${tname}.`);
    }
    this.relayout();
    this.save(true);
  }

  private link(waiter: string, target: string): void {
    const ts = this.persisted.waits.get(waiter) ?? [];
    if (!ts.includes(target)) this.persisted.waits.set(waiter, [...ts, target]);
  }

  // ---- 新しいセッション ----

  private openNew(waitFor?: string, preferredFrom?: string): void {
    const pref = waitFor ?? preferredFrom;
    const prefRoot = pref ? this.rootOfSid(pref) : undefined;
    const paths: string[] = [];
    const add = (p: string | undefined) => {
      if (p && !paths.includes(p)) paths.push(p);
    };
    add(prefRoot);
    add(this.p.launchDir);
    for (const r of this.rows.values()) add(this.p.locations.get(r.cwd)?.root ?? r.cwd);
    const mode: Mode = {k: 'dir', filter: '', sel: 0, items: this.labelDirs(paths), waitFor};
    this.mode = mode;
    void this.p.run('ghq', ['list', '-p'], {timeout: 10000}).then(r => {
      if (r.code !== 0) return;
      for (const l of r.stdout.split('\n')) add(l.trim() || undefined);
      if (this.mode === mode) {
        mode.items = this.labelDirs(paths);
        this.draw();
      }
    });
  }

  private rootOfSid(sid: string): string | undefined {
    const r = this.rows.get(sid);
    if (!r) return undefined;
    return this.p.locations.get(r.cwd)?.root ?? r.cwd;
  }

  private labelDirs(paths: string[]): DirItem[] {
    const t = groupTitles(paths);
    return paths.map(p => ({label: t.get(p) ?? p, path: p}));
  }

  private resolveDir(text: string): string | {error: string} {
    const t = text.trim();
    if (!t) return this.p.launchDir;
    const expanded = t === '~' ? this.p.home : t.startsWith('~/') ? `${this.p.home}${t.slice(1)}` : t;
    if (!expanded.startsWith('/')) return {error: `Not a directory: ${t}`};
    try {
      if (statSync(expanded).isDirectory()) return expanded.replace(/\/+$/, '') || '/';
    } catch {}
    return {error: `Not a directory: ${t}`};
  }

  private async startSession(dir: string, model: string | undefined, waitFor?: string, retried = false): Promise<void> {
    this.mode = {k: 'starting', dir, model, since: this.p.now()};
    const tick = setInterval(() => this.draw(), 1000);
    try {
      const args = ['--bg'];
      if (model) args.push('--model', model);
      if (this.p.settings) args.push('--settings', this.p.settings);
      const r = await this.p.run('claude', args, {cwd: dir, timeout: 120_000});
      const out = stripControl(`${r.stdout}${r.stderr}`);
      if (/Workspace not trusted/i.test(out) && !retried) {
        clearInterval(tick);
        const trusted = await this.trust(dir);
        if (trusted) return this.startSession(dir, model, waitFor, true);
        this.mode = {k: 'list'};
        this.notify(`Not trusted: ${this.tilde(dir)}`);
        return;
      }
      const m = /backgrounded\s*·\s*([0-9a-f]{8})/.exec(out);
      if (!m) {
        this.mode = {
          k: 'output',
          lines: ['claude --bg did not start a session:', ...out.trim().split('\n').slice(0, 10).map(clean)],
        };
        return;
      }
      const id = m[1];
      if (waitFor) this.pendingLinks.push({waiter: waitFor, id});
      this.mode = {k: 'list'};
      await this.attach(id, dir, undefined);
      void this.refresh();
    } finally {
      clearInterval(tick);
      this.draw();
    }
  }

  /** Claude Code 自身の信頼の確認を出す。承認されたら true。 */
  private async trust(dir: string): Promise<boolean> {
    if (!this.mainTty) this.mainTty = await this.p.tmux.option(MAIN_TTY);
    const session = await this.p.tmux.newTrustSession(dir);
    if (!session) return false;
    if (!this.mainTty) {
      await this.killSafely(session);
      return false;
    }
    await this.p.tmux.switchClient(this.mainTty, session);
    this.mainSession = session;
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {}
    for (;;) {
      await sleep(500);
      if (this.isTrusted(dir) || this.isTrusted(real)) {
        await this.p.tmux.switchClient(this.mainTty, LIST);
        this.mainSession = LIST;
        await this.p.tmux.killSession(session);
        return true;
      }
      if (!(await this.p.tmux.hasSession(session))) {
        this.mainSession = LIST;
        return false;
      }
      // 答えずに信頼の確認の画面を離れた(端末を閉じて開き直した、一覧に戻るキーを押した)ら、断ったものとして畳む
      const main = (await this.p.tmux.clients()).find(c => c.tty === this.mainTty);
      if (main && main.session !== session) {
        await this.killSafely(session);
        return false;
      }
    }
  }

  // 手元のファイルを読むだけの確かめ(信頼の記録、ディレクトリがあるか)は口を通さない。通しのテストでは、
  // CLAUDE_CONFIG_DIR と一時ディレクトリで差し替えられる。口に通すのは、外のコマンドと tmux に頼む作業である
  private isTrusted(dir: string): boolean {
    try {
      if (!existsSync(this.p.claudeJson)) return false;
      const j = JSON.parse(readFileSync(this.p.claudeJson, 'utf8')) as {
        projects?: Record<string, {hasTrustDialogAccepted?: boolean}>;
      };
      return j.projects?.[dir]?.hasTrustDialogAccepted === true;
    } catch {
      return false;
    }
  }

  // ---- attach ----

  private async enter(row: ObsRow): Promise<void> {
    if (row.kind !== 'background' || !row.id) {
      this.notify(
        `${row.name}${this.isSpawned(row.sid) ? ' (sub)' : ''} runs in ${clean(row.cwd)} (pid ${row.pid ?? '-'}).`,
        8000,
      );
      return;
    }
    await this.attach(row.id, row.cwd, row.sid);
  }

  private async attach(id: string, cwd: string, sid: string | undefined): Promise<void> {
    const {cols, rows} = this.p.size();
    await this.p.tmux.ensureClaudeSession(id, cwd, {cols, rows});
    // 作り直した claude の画面のセッションには概要がないので、覚えた値を捨てて置き直す
    this.summaries.delete(id);
    const row = sid ? this.rows.get(sid) : [...this.rows.values()].find(r => r.id === id);
    if (row) {
      this.stampAttached(row.sid);
      await this.setSummary(row);
    } else {
      await this.p.tmux.setSummary(id, id);
    }
    if (!this.mainTty) this.mainTty = await this.p.tmux.option(MAIN_TTY);
    if (!this.mainTty) return;
    this.mainSession = id;
    await this.p.tmux.switchClient(this.mainTty, id);
    this.p.log(`attach ${id}`);
    this.follow();
  }

  private stampAttached(sid: string): void {
    const s = this.persisted.seen.get(sid) ?? {first: this.p.now()};
    this.persisted.seen.set(sid, {...s, attached: this.p.now()});
    this.save(false);
  }

  /** attach から一覧に戻った(新しく起動したセッションから戻ったときを含む)。 */
  private onReturn(id: string): void {
    this.p.log(`return ${id}`);
    const row = [...this.rows.values()].find(r => r.id === id);
    if (row) {
      this.stampAttached(row.sid);
      this.cursor = row.sid;
      this.guard = undefined;
      this.relayout();
    } else {
      // 起動した直後で行がまだない。更新のあとに選ぶ
      this.pendingCursorId = id;
    }
    this.fetchUsage();
    void this.refresh();
  }
  private pendingCursorId?: string;
  private firstKnown = new Set<string>();
  private summaries = new Map<string, string>();

  // ---- tmux からの知らせ ----

  signal(): void {
    // 起動が終わるまでは処理しない(頼みごとは tmux のオプションに残り、起動の最後にまとめて読む)
    if (!this.initialized) return;
    this.queue = this.queue.then(() => this.onSignal()).catch(e => this.p.log(`signal failed: ${String(e)}`));
  }

  private async onSignal(): Promise<void> {
    const t = this.p.tmux;
    const [reqs, clients, mainTty, wbTty, closed, newer] = await Promise.all([
      t.takeRequests(),
      t.clients(),
      t.option(MAIN_TTY),
      t.option(WB_TTY),
      t.option('@wn_closed'),
      t.option(NEWER),
    ]);
    this.mainTty = mainTty;
    this.newer = newer || undefined;
    for (const c of clients) {
      if (c.tty !== mainTty && c.tty !== wbTty) {
        this.p.log(`detach ${c.tty} (${c.session})`);
        await t.detachClient(c.tty);
      }
    }
    const main = clients.find(c => c.tty === mainTty);
    const before = this.mainSession;
    if (main) {
      // 端末を閉じたあと(または別の端末に移ったあと)につながったときは、見ていたセッションから戻ったのと同じに扱う
      const from = before && CLAUDE_SESSION.test(before) ? before : this.pendingReturn;
      this.mainSession = main.session;
      this.pendingReturn = undefined;
      if (main.session === LIST && from) this.onReturn(from);
    } else {
      if (before && CLAUDE_SESSION.test(before)) this.pendingReturn = before;
      this.mainSession = undefined;
    }
    await this.afterSignal(reqs, wbTty, closed);
  }

  private async afterSignal(reqs: string[], wbTty: string | undefined, closed: string | undefined): Promise<void> {
    const wbChanged = wbTty !== this.wbTty;
    this.wbTty = wbTty;
    if (closed) {
      await this.p.tmux.unsetOption('@wn_closed');
      for (const id of closed.split(/\s+/).filter(Boolean)) this.closedWorkbench.add(id);
    }
    for (const r of reqs) await this.request(r);
    if (wbChanged || closed) this.follow();
    this.draw();
  }

  private async request(line: string): Promise<void> {
    this.p.log(`request ${line}`);
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'agentview') {
      // 空のプロンプトの ← で Agent View に入った。claude attach を畳んで一覧に戻す
      const session = parts[1];
      if (this.mainTty && this.mainSession === session) {
        await this.p.tmux.switchClient(this.mainTty, LIST);
        this.mainSession = LIST;
        this.onReturn(session);
      }
      if (session && CLAUDE_SESSION.test(session)) await this.p.tmux.killSession(session);
      return;
    }
    if (parts[0] === 'focus') {
      if (parts[1] && parts[1] === this.wbTty) await this.refreshGuidePath();
      return;
    }
    if (parts[0] !== 'key') return;
    const [, action, session, tty] = parts;
    const termname = (await this.p.tmux.clients()).find(c => c.tty === tty)?.termname ?? '';
    const sid = this.sidOfSession(session);
    if (action === GUIDE_CREATE) {
      if (sid) void this.createWorkbench(sid, {from: 'guide'});
      return;
    }
    if (!isAttachAction(action)) return;
    await this.attachKey(action, sid, tty, termname);
  }

  private sidOfSession(session: string | undefined): string | undefined {
    if (!session) return undefined;
    if (session === GUIDE) return this.guideTarget;
    const id = session.startsWith('sh-') ? session.slice(3) : session;
    return [...this.rows.values()].find(r => r.id === id)?.sid;
  }

  private async attachKey(action: AttachAction, sid: string | undefined, tty: string, termname: string): Promise<void> {
    const key = ATTACH_KEYS.find(k => k.action === action);
    if (!key) return;
    if (action === 'vscode') {
      if (sid) void this.openVsCode(sid, {from: 'attach', tty});
      return;
    }
    if (action === 'workbench') {
      if (sid) void this.createWorkbench(sid, {from: 'attach', tty, termname});
      return;
    }
    // 一覧に戻ってから処理する
    const clients = await this.p.tmux.clients();
    const main = clients.find(c => c.tty === this.mainTty);
    if (!main) {
      await this.p.tmux.display(tty, 'The list is not open. Run "whatnext" to open it.', 3000);
      return;
    }
    if (main.session !== LIST) {
      const from = main.session;
      await this.p.tmux.switchClient(main.tty, LIST);
      this.mainSession = LIST;
      if (CLAUDE_SESSION.test(from)) this.onReturn(from);
    }
    if (!sid) return;
    this.cursor = sid;
    this.mode = {k: 'list'};
    if (action === 'note') this.openNote(sid);
    else if (action === 'stop') void this.ctrlX();
    else if (action === 'new') this.openNew(undefined, sid);
    else if (action === 'wait') this.openWait(sid);
    this.draw();
  }

  // ---- 停止と削除 ----

  private async ctrlX(): Promise<void> {
    const sid = this.cursor;
    const row = sid ? this.rows.get(sid) : undefined;
    if (!sid || !row || row.kind !== 'background' || !row.id) return;
    if (this.deleting.has(sid)) return;
    const now = this.p.now();
    if (this.guard && now < this.guard.until) {
      this.notify(`Ctrl+X ignored: ${this.guard.name} left the list and the selection moved.`);
      return;
    }
    if (this.armed?.sid === sid && (now < this.armed.until || this.stopping.has(sid))) {
      this.armed = undefined;
      this.notices = [];
      await this.deleteFlow(sid);
      return;
    }
    this.armed = {sid, until: now + ARM_MS};
    // 止めている途中なら、もう一度は止めない(待ち受けだけを付け直す。次の Ctrl+X は止め終わるのを待って消す)
    if (this.stopping.has(sid)) return;
    if (row.tier === 'stopped') {
      this.notify('Press Ctrl+X again within 2s to delete.', ARM_MS);
      return;
    }
    const id = row.id;
    // 止め終わった時点から待ち受けを数え直し、知らせを出している間は2回目を削除として受け付ける
    const p = (async () => {
      const r = await this.p.run('claude', ['stop', id], {timeout: 30000});
      const ms = r.code === 0 ? ARM_MS : STOP_FAILED_MS;
      // 待ち受けが残っている(止めている間にほかのキーを押していない)ときだけ、2回目で消せると添える
      const armed = this.armed?.sid === sid;
      if (armed && this.armed) this.armed.until = this.p.now() + ms;
      if (r.code !== 0) {
        const out = clean(stripControl(`${r.stdout}${r.stderr}`).trim().split('\n')[0] ?? '');
        this.notify(armed ? `Stop failed: ${out} (Ctrl+X again to delete)` : `Stop failed: ${out}`, ms);
      } else if (!this.deleting.has(sid)) {
        this.notify(
          armed ? `Stopped ${row.name}. Press Ctrl+X again within 2s to delete.` : `Stopped ${row.name}.`,
          ms,
        );
      }
    })();
    this.stopping.set(sid, p);
    this.draw();
    await p;
    if (this.stopping.get(sid) === p) this.stopping.delete(sid);
    this.draw();
    if (!this.deleting.has(sid)) void this.refresh();
  }

  private async deleteFlow(sid: string): Promise<void> {
    const row = this.rows.get(sid);
    if (!row?.id) return;
    this.deleting.add(sid);
    this.draw();
    const inp = this.inputs();
    const cands = cascade(inp, sid).filter(s => this.rows.get(s)?.id);
    let also = false;
    if (cands.length > 0) {
      const names = cands.map(s => this.rows.get(s)?.name ?? s.slice(0, 8));
      const n = cands.length;
      also = await this.ask(
        `Also delete ${n} ${n === 1 ? 'session' : 'sessions'} this one was waiting for? (${names.join(', ')}) [y/N]`,
        false,
      );
    }
    const ok = await this.deleteOne(sid, false);
    if (ok && also) {
      for (const c of cands) this.deleting.add(c);
      this.draw();
      for (const c of cands) await this.deleteOne(c, true);
    }
    await this.refresh();
  }

  /** 1つのセッションを消す。消えたら true。消さなかったら行を元の表示に戻す。 */
  private async deleteOne(sid: string, stopFirst: boolean): Promise<boolean> {
    const row = this.rows.get(sid);
    const id = row?.id;
    if (!row || !id) return false;
    const fail = () => {
      this.deleting.delete(sid);
      this.draw();
      return false;
    };
    // Ctrl+X で止めている途中なら、それが終わるのを待つ(重ねて止めない)
    const inFlight = this.stopping.get(sid);
    await inFlight;
    if (stopFirst && !inFlight && row.tier !== 'stopped' && row.pid !== undefined) {
      await this.p.run('claude', ['stop', id], {timeout: 30000});
    }
    const running = (await this.p.tmux.running()).get(id) ?? [];
    if (running.length > 0) {
      const yes = await this.ask(`Delete ${row.name} and stop ${running.join(', ')}? [y/N]`, false);
      if (!yes) return fail();
    }
    let discard: string | undefined;
    const started = this.p.now();
    for (;;) {
      const args = ['rm', id, ...(discard ? ['--discard-unpushed', discard] : [])];
      const r = await this.p.run('claude', args, {timeout: 60000});
      if (r.code === 0) break;
      const out = stripControl(`${r.stdout}${r.stderr}`).trim();
      const unpushed = /--discard-unpushed\s+(\S+)/.exec(out);
      if (unpushed && !discard) {
        const n = Number(/(\d+) unpushed commit/.exec(out)?.[1] ?? 1);
        const yes = await this.ask(
          `Discard ${n} unpushed ${n === 1 ? 'commit' : 'commits'} and delete session ${id}? [y/N]`,
          false,
        );
        if (!yes) return fail();
        discard = unpushed[1].replace(/[.,;'"“”]+$/, '');
        continue;
      }
      const locked = /^kept\s/.test(out) && !/uncommitted|unpushed/i.test(out);
      if (locked && this.p.now() - started < 60_000) {
        await sleep(1000);
        continue;
      }
      this.notify(out.split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' '), 10000);
      return fail();
    }
    await this.killSafely(`sh-${id}`);
    await this.killSafely(id);
    this.persisted.notes.delete(sid);
    this.persisted.waits.delete(sid);
    this.persisted.seen.delete(sid);
    this.save(false);
    this.notify(`Deleted ${row.name}.`);
    this.follow();
    return true;
  }

  // ---- 確認 ----

  /** 確認を出す。ほかの確認が開いていれば、その後ろに並べる。開いた確認は必ず答えを受けて解決する。 */
  private ask(prompt: string, def: boolean): Promise<boolean> {
    return new Promise(resolve => {
      this.confirms.push({prompt, def, resolve});
      this.draw();
    });
  }

  private answer(yes: boolean): void {
    const c = this.confirms.shift();
    c?.resolve(yes);
    this.draw();
  }

  // ---- VS Code ----

  private async freshCwd(sid: string): Promise<string | undefined> {
    const r = await readAgents(this.p.run);
    const row = this.rows.get(sid);
    if (r.ok) {
      const fresh =
        r.rows.find(x => x.sessionId === sid && x.pid !== undefined) ?? r.rows.find(x => x.sessionId === sid);
      if (fresh) return fresh.cwd;
    }
    return row?.cwd;
  }

  private async openVsCode(sid: string, via: {from: 'list'} | {from: 'attach'; tty: string}): Promise<void> {
    const cwd = await this.freshCwd(sid);
    if (!cwd) return;
    const loc = await locate(this.p.run, cwd);
    const path = loc.repo ? loc.checkout : cwd;
    const url = `vscode://file${path.split('/').map(encodeURIComponent).join('/')}/?windowId=_blank`;
    const r = await this.p.run('open', [url], {timeout: 15000});
    const msg =
      r.code === 0
        ? `Opened ${clean(this.tilde(path))} in VS Code.`
        : `open failed: ${clean(stripControl(r.stderr || r.stdout).trim())}`;
    if (via.from === 'list') this.notify(msg);
    else await this.p.tmux.display(via.tty, msg, 3000);
  }

  // ---- 作業台 ----

  private async createWorkbench(
    sid: string,
    via: {from: 'list'} | {from: 'guide'} | {from: 'attach'; tty: string; termname: string},
  ): Promise<void> {
    const row = this.rows.get(sid);
    if (!row) return;
    const say = async (msg: string) => {
      if (via.from === 'attach') await this.p.tmux.display(via.tty, msg, 3000);
      else if (via.from === 'list') this.notify(msg);
    };
    if (row.kind !== 'background' || !row.id) {
      await say(`${row.name} is an interactive session. It has no workbench.`);
      return;
    }
    const id = row.id;
    const exists = await this.p.tmux.hasSession(`sh-${id}`);
    if (!exists) {
      const cwd = (await this.freshCwd(sid)) ?? row.cwd;
      await this.p.tmux.createWorkbench(id, cwd, row.name);
      this.closedWorkbench.delete(id);
    }
    let termname = via.from === 'attach' ? via.termname : '';
    if (via.from === 'list' && this.mainTty) {
      termname = (await this.p.tmux.clients()).find(c => c.tty === this.mainTty)?.termname ?? '';
    }
    const wbOpen = !!this.wbTty && (await this.p.tmux.clients()).some(c => c.tty === this.wbTty);
    if (via.from !== 'guide' && termname.includes('ghostty')) {
      const res = wbOpen
        ? await focusWorkbench(this.p.run)
        : await splitWorkbench(this.p.run, this.p.workbenchCommand, {
            WHATNEXT_TMUX_SOCKET: this.p.socket,
            WHATNEXT_PORT: String(this.p.port),
          });
      this.p.log(`ghostty ${res}`);
      if (res === 'focused' || res === 'split') {
        this.follow();
        return;
      }
    }
    if (exists) await say(`Workbench already exists for ${row.name}.`);
    else if (!wbOpen) await say('Workbench created. Run "whatnext workbench" in a split to see it.');
    this.follow();
  }

  private guideTarget?: string;

  /** 作業台の画面を、whatnext の画面が映すものに合わせて切り替える(60ms まとめてから、順に)。 */
  follow(): void {
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => {
      this.followChain = this.followChain.then(() => this.doFollow()).catch(e => this.p.log(`follow: ${String(e)}`));
    }, 60);
  }

  private async doFollow(): Promise<void> {
    const wb = this.wbTty;
    if (!wb) return;
    const t = this.p.tmux;
    let sid: string | undefined;
    if (this.mainSession && CLAUDE_SESSION.test(this.mainSession)) {
      sid = [...this.rows.values()].find(r => r.id === this.mainSession)?.sid;
    } else if (!this.mainSession || this.mainSession === LIST) sid = this.cursor;
    else return;
    const row = sid ? this.rows.get(sid) : undefined;
    let target: string = GUIDE;
    let g: GuideState = {kind: 'empty'};
    if (row) {
      if (row.kind !== 'background' || !row.id) g = {kind: 'tty', name: row.name};
      else if (await t.hasSession(`sh-${row.id}`)) target = `sh-${row.id}`;
      else g = {kind: 'none', name: row.name, path: this.tilde(row.cwd), closed: this.closedWorkbench.has(row.id)};
    }
    this.guideTarget = row?.sid;
    if (target === GUIDE) {
      const text = JSON.stringify(g);
      if (text !== this.lastGuide) {
        this.lastGuide = text;
        await t.setOption(GUIDE_OPTION, text);
        await t.setSessionName(GUIDE, row?.name ?? '');
        await t.signalGuide();
      }
    }
    const clients = await t.clients();
    const c = clients.find(x => x.tty === wb);
    if (c && c.session !== target) await t.switchClient(wb, target);
  }

  private async refreshGuidePath(): Promise<void> {
    const sid = this.guideTarget;
    if (!sid) return;
    const cwd = await this.freshCwd(sid);
    const row = this.rows.get(sid);
    if (row && cwd && cwd !== row.cwd) {
      this.rows.set(sid, {...row, cwd});
      // 行の cwd と場所の表を同じ時点の組にする(引き直さないと、次の更新まで区切りとブランチがずれる)
      await this.p.locations.refresh([...this.rows.values()].filter(r => r.tier !== null).map(r => r.cwd));
      this.relayout();
      this.lastGuide = undefined;
      this.draw();
      this.follow();
    }
  }

  // ---- 終了 ----

  private async quit(): Promise<void> {
    const running = await this.p.tmux.running();
    const items: string[] = [];
    for (const [k, cmds] of running) {
      if (cmds.length === 0) continue;
      const id = k.startsWith('sh-') ? k.slice(3) : k;
      const name = [...this.rows.values()].find(r => r.id === id)?.name ?? id;
      items.push(`${name}: ${cmds.join(', ')}`);
    }
    const n = [...running.values()].reduce((a, c) => a + c.length, 0);
    if (n > 0) {
      const yes = await this.ask(
        `Quit and stop ${n} running ${n === 1 ? 'command' : 'commands'}? ${items.join(', ')} [y/N]`,
        false,
      );
      if (!yes) return;
    }
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    this.quitting = true;
    this.p.stateFile.save(this.persisted, false);
    this.p.log('quit');
    await this.p.tmux.killServer();
    this.p.exit(0);
  }

  /** 確認を出せずに終わるとき(シグナル、想定外の例外)。動いているものがある作業台だけを残す。 */
  async abnormalExit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    this.p.stateFile.save(this.persisted, false);
    const t = this.p.tmux;
    const running = await t.running();
    for (const s of await t.sessions()) {
      if (CLAUDE_SESSION.test(s) || s.startsWith('trust-')) await t.killSession(s);
      else if (s.startsWith('sh-') && (running.get(s.slice(3)) ?? []).length === 0) await t.killSession(s);
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function dropLast(s: string): string {
  const seg = [...new Intl.Segmenter().segment(s)];
  return seg
    .slice(0, -1)
    .map(x => x.segment)
    .join('');
}
