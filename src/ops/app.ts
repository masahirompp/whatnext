// 操作: 一覧の状態の遷移と、外部に頼む作業の指示(DESIGN.md「モジュールの境界」)。

import {basename} from 'node:path';
import type {UsageFrame} from '../input/claude.js';
import {stripControl} from '../input/exec.js';
import type {Place, PullRequest} from '../input/place.js';
import {vscodeDevUrl} from '../input/place.js';
import {
  type Arranged,
  arrange,
  type DoneMemo,
  type Entry,
  emptyDoneMemo,
  emptyWaitMemo,
  flatten,
  type Supplement,
  subtreeOf,
  trackWaits,
  type WaitMemo,
} from '../ladder/arrange.js';
import {type AgentRow, dedupe, rowName} from '../ladder/classify.js';
import {frame, type Panel, render, type ScreenModel, type ScreenRow} from '../screen/render.js';
import type {Relations} from '../state/store.js';
import type {KeyAction} from '../tmux/keys.js';
import {GUIDE, LIST} from '../tmux/tmux.js';
import {displayNames, expandHome, filterIndexes, tildify} from './pick.js';
import type {Observed, Ports} from './ports.js';

export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export const REFRESH_MS = 60_000;
const USAGE_MS = 60_000;
const ARM_MS = 2_000;
const MOVED_MS = 2_000;
const FLASH_MS = 2_000;

export const LIST_HELP =
  '↑↓ select · Enter attach · n new · ^X stop/delete · h hold · f wait for · w workbench · e external · r refresh · q quit';

interface Snapshot {
  state?: string;
  status?: string;
  waitingFor?: string;
  activity: number;
}

interface Attached {
  /** 起動した直後で `--json` にまだ出ていなければ undefined。 */
  sid?: string;
  id: string;
  snapshot?: Snapshot;
}

interface Candidate {
  name: string;
  path: string;
}

type Mode =
  | {kind: 'list'}
  | {kind: 'hold'; sid: string; value: string}
  | {kind: 'confirm'; text: string; defaultYes: boolean; resolve: (yes: boolean) => void}
  | {kind: 'ext'; sid: string; items: ExtItem[]; sel: number}
  | {kind: 'wait'; waiter: string; filter: string; sel: number}
  | {kind: 'dir'; filter: string; sel: number; cands: Candidate[]; flow: NewFlow}
  | {kind: 'other'; value: string; error?: string; flow: NewFlow; cands: Candidate[]; filter: string}
  | {kind: 'model'; sel: number; dir: string; flow: NewFlow}
  | {kind: 'modelName'; value: string; dir: string; flow: NewFlow}
  | {kind: 'starting'; dir: string; model?: string; startedAt: number}
  | {kind: 'pressKey'; lines: string[]};

interface NewFlow {
  firstRepo?: string;
  /** `f` の New session から起動したときの待ち元。 */
  linkTo?: string;
}

interface ExtItem {
  label: string;
  target?: string;
  what?: string;
}

interface Message {
  text: string;
  until?: number;
}

export interface AppInit {
  relations: Relations;
  version: string;
  /** 前の whatnext が残した、動いているものがある作業台(id → コマンド行)。 */
  leftovers?: Map<string, string[]>;
}

export class App {
  // 観測
  private rows: AgentRow[] | null = null;
  private error: string | undefined;
  private observed = new Map<string, Observed>();
  private places = new Map<string, Place>();
  private prs = new Map<string, PullRequest | null>();
  private running = new Map<string, string[]>();
  private usage: UsageFrame[] | undefined;
  private usageStartedAt = -Infinity;
  private usageInFlight = false;
  private refreshedAt = 0;

  // 段と並び
  private waitMemo: WaitMemo = emptyWaitMemo;
  private doneMemo: DoneMemo = emptyDoneMemo;
  private arranged: Arranged | null = null;

  // 利用者の注釈
  private holds: Map<string, string>;
  private waits: Map<string, string[]>;

  // 画面と操作の状態
  private cursor: string | null = null;
  private lastAttached: string | null = null;
  private attached: Attached | null = null;
  private mode: Mode = {kind: 'list'};
  private messages: Message[] = [];
  private notice: string | undefined;
  private refreshing = false;
  private refreshQueued = false;
  private refreshTimer: {cancel(): void} | undefined;
  private transient = new Map<string, 'stopping' | 'deleting'>();
  private arm: {sid: string; until: number} | null = null;
  private moved: {name: string; until: number} | null = null;
  private pendingLinks: {waiter: string; id: string}[] = [];
  private leftSnapshots: {sid: string; snapshot: Snapshot}[] = [];
  private leftovers: Map<string, string[]> | undefined;
  private menuChoices = new Map<string, ExtItem[]>();
  private menuSeq = 0;
  private firstPrompts = new Map<string, string>();
  private summaryRetry = new Set<string>();
  private wbTimer: {cancel(): void} | undefined;
  private wbChain: Promise<void> = Promise.resolve();
  private signalChain: Promise<void> = Promise.resolve();
  private drawQueued = false;
  private trust: {dir: string; session: string; flow: NewFlow; model?: string} | null = null;
  private quitting = false;

  constructor(
    private readonly p: Ports,
    init: AppInit,
  ) {
    this.holds = new Map(init.relations.holds);
    this.waits = new Map([...init.relations.waits].map(([k, v]) => [k, [...v]]));
    this.leftovers = init.leftovers && init.leftovers.size > 0 ? init.leftovers : undefined;
  }

  // ---- 起動と更新 ----

  async start(): Promise<void> {
    this.draw();
    void this.fetchUsage(true);
    await this.refresh();
    if (this.leftovers) {
      const left = this.leftovers;
      this.leftovers = undefined;
      const list = [...left].map(([id, cmds]) => `${this.nameOfId(id)}: ${cmds.join(', ')}`).join(', ');
      const n = [...left.values()].reduce((a, c) => a + c.length, 0);
      const keep = await this.confirm(
        `${n} ${n === 1 ? 'command is' : 'commands are'} still running from a previous whatnext: ${list}. Keep them? [Y/n]`,
        true,
      );
      if (!keep) for (const id of left.keys()) await this.p.tmux.killSession(`sh-${id}`);
      this.draw();
    }
  }

  /** `--json` を読み直して並べ直す。 */
  async refresh(opts: {flash?: boolean} = {}): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    this.refreshTimer?.cancel();
    this.draw();
    try {
      const res = await this.p.readAgents();
      const now = this.p.now();
      if (!res.ok) {
        this.rows = null;
        this.error = res.error;
        this.arranged = null;
      } else {
        this.error = undefined;
        const rows = dedupe(res.rows);
        const [observed, running] = await Promise.all([this.p.observe(rows), this.p.tmux.running()]);
        await this.loadPlaces(rows);
        this.observed = observed;
        this.running = running;
        this.rows = rows;
        this.prune(rows);
        this.resolvePendingLinks(rows);
        if (this.attached && !this.attached.sid) {
          const att = this.attached;
          const r = rows.find(x => x.id === att.id);
          if (r) att.sid = r.sessionId;
        }
        this.rearrange(now, true);
        this.releaseHolds();
        void this.updateSummaries();
        void this.loadPullRequests(rows);
      }
      this.refreshedAt = now;
      if (opts.flash) this.flash('Refreshed.', FLASH_MS);
    } finally {
      this.refreshing = false;
      this.refreshTimer = this.p.setTimer(() => void this.refresh(), REFRESH_MS);
      this.draw();
      this.scheduleWbSync();
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private async loadPlaces(rows: AgentRow[]): Promise<void> {
    const cwds = [...new Set(rows.map(r => r.cwd).filter(Boolean))];
    const got = await Promise.all(cwds.map(c => this.p.place(c)));
    const next = new Map<string, Place>();
    for (const [i, c] of cwds.entries()) next.set(c, got[i] as Place);
    this.places = next;
  }

  private async loadPullRequests(rows: AgentRow[]): Promise<void> {
    const keys = new Map<string, {cwd: string; branch: string}>();
    for (const r of rows) {
      const pl = this.places.get(r.cwd);
      if (pl?.git && pl.branch && pl.nonDefault)
        keys.set(`${pl.mainRoot}\t${pl.branch}`, {cwd: r.cwd, branch: pl.branch});
    }
    await Promise.all(
      [...keys].map(async ([k, v]) => {
        const pr = await this.p.pullRequest(v.cwd, v.branch);
        this.prs.set(k, pr ?? null);
      }),
    );
    this.draw();
  }

  private prOf(cwd: string): PullRequest | undefined {
    const pl = this.places.get(cwd);
    if (!pl?.branch || !pl.nonDefault) return undefined;
    return this.prs.get(`${pl.mainRoot}\t${pl.branch}`) ?? undefined;
  }

  /** `--json` から消えたセッションの関係と、一覧に出なくなったセッションの保留を外す。 */
  private prune(rows: AgentRow[]): void {
    const present = new Set(rows.map(r => r.sessionId));
    for (const [w, ts] of this.waits) {
      if (!present.has(w)) {
        this.waits.delete(w);
        continue;
      }
      const kept = ts.filter(t => present.has(t));
      if (kept.length !== ts.length) this.cutWaits(w, kept);
    }
    this.save();
  }

  /** 待ち先が削除されて関係が切れたときは `↳ done` を出さない。 */
  private cutWaits(waiter: string, kept: string[]): void {
    if (kept.length === 0) this.waits.delete(waiter);
    else this.waits.set(waiter, kept);
    const done = new Set(this.doneMemo.done);
    const waiting = new Set(this.doneMemo.waiting);
    done.delete(waiter);
    waiting.delete(waiter);
    this.doneMemo = {done, waiting};
  }

  private resolvePendingLinks(rows: AgentRow[]): void {
    this.pendingLinks = this.pendingLinks.filter(pl => {
      const r = rows.find(x => x.id === pl.id);
      if (!r) return true;
      if (rows.some(x => x.sessionId === pl.waiter)) this.link(pl.waiter, r.sessionId);
      return false;
    });
  }

  /** 観測を変えずに並べ直す(保留や待ち先を変えたとき)。`track` なら待機時間も決め直す(更新のとき)。 */
  private rearrange(now: number, track: boolean): void {
    if (!this.rows) return;
    const sups = new Map<string, Supplement>();
    for (const [sid, o] of this.observed) sups.set(sid, o.sup);
    const visible = new Set<string>();
    let a = arrange({
      rows: this.rows,
      holds: this.holds,
      waits: this.waits,
      lastAttached: this.lastAttached,
      waitSince: this.waitMemo.entries.size ? this.sinceMap() : new Map(),
      sups,
      doneMemo: this.doneMemo,
    });
    if (track) {
      this.waitMemo = trackWaits(this.waitMemo, a.tiers, sups, now);
      a = arrange({
        rows: this.rows,
        holds: this.holds,
        waits: this.waits,
        lastAttached: this.lastAttached,
        waitSince: this.sinceMap(),
        sups,
        doneMemo: this.doneMemo,
      });
    }
    this.doneMemo = a.doneMemo;
    for (const sid of a.tiers.keys()) visible.add(sid);
    // 一覧に出なくなったセッションの保留を外す。
    let changed = false;
    for (const sid of [...this.holds.keys()])
      if (!visible.has(sid)) {
        this.holds.delete(sid);
        changed = true;
      }
    if (changed) {
      this.rearrange(now, false);
      return;
    }
    this.arranged = a;
    if (this.lastAttached && !visible.has(this.lastAttached)) this.lastAttached = null;
    this.fixCursor();
    this.save();
  }

  private sinceMap(): Map<string, number | null> {
    const m = new Map<string, number | null>();
    for (const [sid, e] of this.waitMemo.entries) m.set(sid, e.since);
    return m;
  }

  private entries(): Entry[] {
    return this.arranged ? flatten(this.arranged) : [];
  }

  private fixCursor(): void {
    const list = this.entries();
    if (this.cursor && list.some(e => e.sid === this.cursor)) return;
    const prev = this.cursor;
    const top = this.arranged?.upNext[0]?.positionSid ?? list[0]?.sid ?? null;
    if (prev && top !== prev) {
      const name = this.nameOf(prev);
      if (top) this.moved = {name, until: this.p.now() + MOVED_MS};
    }
    this.cursor = top;
  }

  private save(): void {
    this.p.saveState({holds: this.holds, waits: this.waits});
  }

  private releaseHolds(): void {
    const left = this.leftSnapshots;
    this.leftSnapshots = [];
    let changed = false;
    for (const {sid, snapshot} of left) {
      if (!this.holds.has(sid)) continue;
      const row = this.rows?.find(r => r.sessionId === sid);
      const now = row ? this.snapshotOf(row) : undefined;
      const worked =
        !now ||
        now.state !== snapshot.state ||
        now.status !== snapshot.status ||
        now.waitingFor !== snapshot.waitingFor ||
        now.activity > snapshot.activity;
      if (worked) {
        this.holds.delete(sid);
        changed = true;
      }
    }
    if (changed) this.rearrange(this.p.now(), false);
  }

  private snapshotOf(row: AgentRow): Snapshot {
    return {
      state: row.state,
      status: row.status,
      waitingFor: row.waitingFor,
      activity: this.observed.get(row.sessionId)?.activity ?? 0,
    };
  }

  async fetchUsage(force = false): Promise<void> {
    const now = this.p.now();
    if (this.usageInFlight) return;
    if (!force && now - this.usageStartedAt < USAGE_MS) return;
    this.usageInFlight = true;
    this.usageStartedAt = now;
    try {
      const u = await this.p.usage();
      if (u) this.usage = u;
    } finally {
      this.usageInFlight = false;
      this.draw();
    }
  }

  // ---- 名前と場所 ----

  private rowOf(sid: string | null | undefined): AgentRow | undefined {
    return sid ? this.rows?.find(r => r.sessionId === sid) : undefined;
  }

  private nameOf(sid: string): string {
    const r = this.rowOf(sid);
    return r ? rowName(r) : sid.slice(0, 8);
  }

  private nameOfId(id: string): string {
    const r = this.rows?.find(x => x.id === id);
    return r ? rowName(r) : id;
  }

  private sidOfId(id: string): string | undefined {
    return this.rows?.find(x => x.id === id)?.sessionId;
  }

  private mainRootOf(sid: string): string | undefined {
    const r = this.rowOf(sid);
    if (!r) return undefined;
    return this.places.get(r.cwd)?.mainRoot ?? r.cwd;
  }

  // ---- 描画 ----

  draw(): void {
    if (this.drawQueued || this.quitting) return;
    this.drawQueued = true;
    setImmediate(() => {
      this.drawQueued = false;
      if (this.quitting) return;
      this.p.write(frame(render(this.model())));
    });
  }

  /** 画面の組み立てに渡すもの。 */
  model(): ScreenModel {
    const {cols, rows} = this.p.size();
    const now = this.p.now();
    this.messages = this.messages.filter(m => m.until === undefined || m.until > now);
    const msgs: string[] = [];
    if (this.refreshing) msgs.push('refreshing...');
    msgs.push(...this.messages.map(m => m.text));
    if (this.notice) msgs.push(this.notice);
    const m: ScreenModel = {
      cols,
      rows,
      usage: this.usage,
      upNext: [],
      cursor: this.cursor,
      asOf: this.refreshedAt,
      messages: msgs,
      panel: this.panel(),
      help: this.mode.kind === 'list' ? LIST_HELP : '',
    };
    if (this.rows === null) {
      m.placeholder = this.error ?? 'Loading...';
      return m;
    }
    const a = this.arranged;
    if (!a || (a.upNext.length === 0 && !a.lastAttached && a.onHold.length === 0)) {
      m.placeholder = 'No sessions to show.';
      return m;
    }
    const conv = (es: Entry[]) => es.map((e, i) => this.screenRow(e, es[i + 1]));
    if (a.lastAttached) m.lastAttached = conv(a.lastAttached.entries);
    m.upNext = a.upNext.flatMap(g => conv(g.entries));
    if (a.onHold.length > 0) m.onHold = a.onHold.flatMap(g => conv(g.entries));
    return m;
  }

  private screenRow(e: Entry, next: Entry | undefined): ScreenRow {
    const pl = this.places.get(e.row.cwd);
    const pr = this.prOf(e.row.cwd);
    const notes: string[] = [];
    if (e.note) notes.push(e.note);
    const cmds = e.row.id ? this.running.get(e.row.id) : undefined;
    if (cmds && cmds.length > 0) notes.push(`⚙ ${cmds.join(' · ')}`);
    if (e.doneNames) notes.push(`↳ ${e.doneNames.join(', ')} done`);
    if (e.holdReason) notes.push(`↳ ${e.holdReason}`);
    return {
      key: e.sid,
      name: e.name,
      tty: e.row.kind === 'interactive',
      midHold: e.midHold,
      depth: e.depth,
      lastChain: e.lastChain,
      hasChildren: next !== undefined && next.depth > e.depth,
      tier: e.tier,
      status: e.status,
      transient: this.transient.get(e.sid),
      where: pl
        ? {
            repo: pl.repo,
            branch: pl.nonDefault ? pl.branch : undefined,
            worktree: pl.worktree,
            pr: pr ? {number: pr.number, state: pr.state} : undefined,
          }
        : undefined,
      ctx: e.ctx,
      since: e.since,
      notes,
    };
  }

  private panel(): Panel | undefined {
    const md = this.mode;
    const home = this.p.home;
    switch (md.kind) {
      case 'list':
        return undefined;
      case 'hold':
        return {
          kind: 'input',
          prompt: `Put ${this.nameOf(md.sid)} on hold. Reason (optional):`,
          value: md.value,
          hint: 'Enter confirm · Esc cancel',
        };
      case 'confirm':
        return {kind: 'confirm', text: md.text};
      case 'ext':
        return {
          kind: 'menu',
          title: `Show ${this.nameOf(md.sid)} in:`,
          items: md.items.map(it => ({label: it.label, disabled: it.target === undefined})),
          selected: md.sel,
          numbered: true,
          footer: '↑↓ select · Enter open · 1-9 pick · Esc close',
        };
      case 'wait': {
        const opts = this.waitOptions(md.waiter, md.filter);
        return {
          kind: 'menu',
          title: `${this.nameOf(md.waiter)} waits for:`,
          filter: md.filter,
          items: opts.map(o => ({label: o.label, detail: o.detail, marked: o.marked})),
          selected: md.sel,
          footer: 'Type to filter · Enter select · Esc close',
        };
      }
      case 'dir': {
        const idx = this.dirIndexes(md);
        return {
          kind: 'menu',
          title: 'New session — working directory:',
          filter: md.filter,
          items: [
            ...idx.map(i => ({
              label: (md.cands[i] as Candidate).name,
              detail: tildify((md.cands[i] as Candidate).path, home),
            })),
            {label: 'Other...'},
          ],
          selected: md.sel,
          footer: 'Type to filter · Enter select · Esc back',
        };
      }
      case 'other':
        return {
          kind: 'input',
          prompt: 'Directory:',
          value: md.value,
          error: md.error,
          hint: `Enter confirm (empty: ${tildify(this.p.startDir, home)}) · Esc back`,
        };
      case 'model':
        return {
          kind: 'menu',
          title: `New session in ${tildify(md.dir, home)} — model:`,
          items: [{label: 'default'}, {label: 'Other...'}],
          selected: md.sel,
          footer: 'Enter select · Esc back',
        };
      case 'modelName':
        return {kind: 'input', prompt: 'Model:', value: md.value, hint: 'Enter confirm · Esc back'};
      case 'starting': {
        const secs = Math.floor((this.p.now() - md.startedAt) / 1000);
        return {
          kind: 'text',
          lines: [
            `New session in ${tildify(md.dir, home)} (model: ${md.model ?? 'default'})`,
            `Starting the session... ${secs}s`,
          ],
        };
      }
      case 'pressKey':
        return {kind: 'text', lines: [...md.lines, 'Press any key to return to the list.']};
    }
  }

  private flash(text: string, ms?: number): void {
    this.messages = [{text, until: ms !== undefined ? this.p.now() + ms : undefined}];
    if (ms !== undefined) this.p.setTimer(() => this.draw(), ms + 20);
    this.draw();
  }

  setNotice(text: string | undefined): void {
    this.notice = text;
    this.draw();
  }

  // ---- キー ----

  paste(text: string): void {
    const t = text.replace(/[\r\n]+/g, ' ');
    const md = this.mode;
    if (md.kind === 'hold' || md.kind === 'other' || md.kind === 'modelName') {
      md.value += t;
      if (md.kind === 'other') md.error = undefined;
    } else if (md.kind === 'dir' || md.kind === 'wait') {
      md.filter += t;
      md.sel = md.kind === 'wait' && md.filter ? 1 : 0;
    }
    this.draw();
  }

  key(str: string | undefined, k: Key): void {
    if (this.quitting) return;
    if (k.ctrl && k.name === 'q') return;
    if (k.ctrl && k.name === 'c' && this.mode.kind === 'list') return;
    const md = this.mode;
    switch (md.kind) {
      case 'list':
        this.listKey(str, k);
        return;
      case 'confirm': {
        const yes = k.name === 'y' && !k.ctrl;
        const no = (k.name === 'n' && !k.ctrl) || k.name === 'escape';
        const enter = k.name === 'return';
        if (!yes && !no && !enter) return;
        this.mode = {kind: 'list'};
        md.resolve(yes || (enter && md.defaultYes));
        this.draw();
        return;
      }
      case 'hold':
        this.inputKey(str, k, md, () => {
          this.mode = {kind: 'list'};
          this.putOnHold(md.sid, md.value.trim());
        });
        return;
      case 'ext':
        this.extKey(str, k, md);
        return;
      case 'wait':
        this.waitKey(str, k, md);
        return;
      case 'dir':
        this.dirKey(str, k, md);
        return;
      case 'other':
        this.inputKey(
          str,
          k,
          md,
          () => void this.otherDone(md),
          () => {
            this.mode = {kind: 'dir', filter: md.filter, sel: 0, cands: md.cands, flow: md.flow};
            this.draw();
          },
        );
        return;
      case 'model':
        if (k.name === 'escape') {
          this.openDirPicker(md.flow);
          return;
        }
        if (k.name === 'up' || k.name === 'down') md.sel = md.sel === 0 ? 1 : 0;
        else if (k.name === 'return') {
          if (md.sel === 0) void this.launch(md.dir, undefined, md.flow);
          else this.mode = {kind: 'modelName', value: '', dir: md.dir, flow: md.flow};
        }
        this.draw();
        return;
      case 'modelName':
        this.inputKey(
          str,
          k,
          md,
          () => {
            if (md.value.trim() === '') return;
            void this.launch(md.dir, md.value.trim(), md.flow);
          },
          () => {
            this.mode = {kind: 'model', sel: 1, dir: md.dir, flow: md.flow};
            this.draw();
          },
        );
        return;
      case 'starting':
        return;
      case 'pressKey':
        this.mode = {kind: 'list'};
        this.draw();
        return;
    }
  }

  private inputKey(
    str: string | undefined,
    k: Key,
    md: {value: string; error?: string},
    done: () => void,
    cancel?: () => void,
  ): void {
    if (k.name === 'escape') {
      if (cancel) cancel();
      else {
        this.mode = {kind: 'list'};
        this.draw();
      }
      return;
    }
    if (k.name === 'return') {
      done();
      this.draw();
      return;
    }
    if (k.name === 'backspace') {
      const segs = [...new Intl.Segmenter().segment(md.value)];
      md.value = segs
        .slice(0, -1)
        .map(s => s.segment)
        .join('');
    } else if (str && !k.ctrl && !k.meta && str >= ' ' && str !== '\x7f') md.value += str;
    if ('error' in md) md.error = undefined;
    this.draw();
  }

  private listKey(str: string | undefined, k: Key): void {
    const isCtrlX = k.ctrl && k.name === 'x';
    if (!isCtrlX && this.arm) {
      this.arm = null;
      this.messages = [];
    }
    if (!isCtrlX) this.moved = null;
    const list = this.entries();
    const i = list.findIndex(e => e.sid === this.cursor);
    const sel = this.cursor;
    switch (k.name) {
      case 'up':
        if (i > 0) this.cursor = (list[i - 1] as Entry).sid;
        this.messages = [];
        break;
      case 'down':
        if (i >= 0 && i < list.length - 1) this.cursor = (list[i + 1] as Entry).sid;
        else if (i < 0 && list[0]) this.cursor = list[0].sid;
        this.messages = [];
        break;
      case 'home':
        if (list[0]) this.cursor = list[0].sid;
        break;
      case 'end':
        if (list.length) this.cursor = (list[list.length - 1] as Entry).sid;
        break;
      case 'return':
        if (sel) void this.enter(sel);
        break;
      case 'escape':
        this.messages = [];
        break;
      default:
        if (isCtrlX) {
          if (sel) void this.ctrlX(sel);
          return;
        }
        if (k.ctrl || k.meta) return;
        switch (str) {
          case 'n':
            this.openDirPicker({});
            break;
          case 'h':
            if (sel) this.hold(sel);
            break;
          case 'f':
            if (sel) this.openWait(sel);
            break;
          case 'w':
            if (sel) void this.makeWorkbench(sel, {from: 'list'});
            break;
          case 'e':
            if (sel) this.openExt(sel);
            break;
          case 'r':
            this.messages = [];
            void this.fetchUsage();
            void this.refresh({flash: true});
            break;
          case 'q':
            void this.quit();
            break;
        }
    }
    this.draw();
    this.scheduleWbSync();
  }

  private isDeleting(sid: string): boolean {
    return this.transient.get(sid) === 'deleting';
  }

  // ---- attach ----

  private async enter(sid: string): Promise<void> {
    const row = this.rowOf(sid);
    if (!row || this.isDeleting(sid)) return;
    if (row.kind === 'interactive' || !row.id) {
      this.flash(`${rowName(row)} is an interactive session (no attach). pid ${row.pid ?? '-'} · ${row.cwd}`);
      return;
    }
    await this.attach(sid);
  }

  private async mainTty(): Promise<string | undefined> {
    return (await this.p.tmux.option('@wn_main_tty')) || undefined;
  }

  private async attach(sid: string): Promise<void> {
    const row = this.rowOf(sid);
    if (!row?.id) return;
    const id = row.id;
    const ok = await this.p.tmux.ensureClaudeSession(id, row.cwd, this.p.size());
    if (!ok) {
      this.flash(`Could not attach to ${rowName(row)}.`);
      return;
    }
    await this.p.tmux.setSummary(id, this.summaryText(sid, id));
    this.attached = {sid, id, snapshot: this.snapshotOf(row)};
    this.clearDone(sid);
    const tty = await this.mainTty();
    await this.syncWorkbench(id);
    if (tty) await this.p.tmux.switchClient(tty, id);
  }

  private clearDone(sid: string): void {
    const done = new Set(this.doneMemo.done);
    done.delete(sid);
    this.doneMemo = {done, waiting: this.doneMemo.waiting};
  }

  private summaryText(sid: string | undefined, id: string): string {
    const name = sid ? this.nameOf(sid) : this.nameOfId(id);
    const first = sid ? this.firstPrompts.get(sid) : undefined;
    return first ? `${name} · ${first}` : name;
  }

  private async updateSummaries(): Promise<void> {
    if (!this.rows) return;
    const sessions = new Set(await this.p.tmux.sessions());
    for (const r of this.rows) {
      if (!r.id || !sessions.has(r.id)) continue;
      if (!this.firstPrompts.has(r.sessionId)) {
        const f = await this.p.firstPrompt(r.sessionId);
        if (f) this.firstPrompts.set(r.sessionId, f);
      }
      await this.p.tmux.setSummary(r.id, this.summaryText(r.sessionId, r.id));
    }
    for (const s of sessions)
      if (s.startsWith('sh-')) {
        const id = s.slice(3);
        await this.p.tmux.setSessionName(s, this.nameOfId(id));
      }
  }

  /** フックを受けたとき。最初の依頼を送ったセッションの概要の行を、更新を待たずに置き直す。 */
  onHook(sid: string, event: string): void {
    if (event !== 'UserPromptSubmit' || this.firstPrompts.has(sid) || this.summaryRetry.has(sid)) return;
    this.summaryRetry.add(sid);
    // `id` は `sessionId` の先頭 8 文字なので、`--json` を読み直さずに決まる。
    const id = sid.slice(0, 8);
    const delays = [0, 300, 700, 1000, 1500, 2000, 2500, 3000];
    let n = 0;
    const tryOnce = async () => {
      const f = await this.p.firstPrompt(sid, true);
      if (f) {
        this.firstPrompts.set(sid, f);
        this.summaryRetry.delete(sid);
        await this.p.tmux.setSummary(id, this.summaryText(sid, id));
        return;
      }
      n++;
      if (n >= delays.length) {
        this.summaryRetry.delete(sid);
        return;
      }
      this.p.setTimer(() => void tryOnce(), delays[n] as number);
    };
    void tryOnce();
  }

  // ---- tmux からの知らせ ----

  /** SIGUSR2 を受けたとき。知らせは順に処理する。 */
  signal(): Promise<void> {
    this.signalChain = this.signalChain.then(() => this.handleSignal()).catch(() => {});
    return this.signalChain;
  }

  private async handleSignal(): Promise<void> {
    const reqs = await this.p.tmux.takeRequests();
    const clients = await this.p.tmux.clients();
    const mainTty = await this.mainTty();
    const main = clients.find(c => c.tty === mainTty);
    const newer = await this.p.tmux.option('@wn_newer');
    if (newer) {
      const running = (await this.p.tmux.option('@wn_version')) ?? '?';
      this.setNotice(`whatnext ${running} is still running. Quit it to start ${newer}.`);
    }
    // attach から戻ったか
    const att = this.attached;
    if (att && main && main.session !== att.id && !main.session.startsWith('trust-')) {
      if (main.session === LIST) await this.returned(att);
    }
    for (const r of reqs) await this.request(r, clients);
    this.scheduleWbSync();
  }

  /** attach から戻ったとき(新しく起動したセッションから戻ったときを含む)。 */
  private async returned(att: Attached): Promise<void> {
    this.attached = null;
    const sid = att.sid ?? this.sidOfId(att.id);
    if (sid) {
      this.lastAttached = sid;
      this.cursor = sid;
      if (att.snapshot) this.leftSnapshots.push({sid, snapshot: att.snapshot});
    } else this.pendingReturnId = att.id;
    void this.fetchUsage();
    await this.refresh();
    if (!sid && this.pendingReturnId) {
      const s2 = this.sidOfId(this.pendingReturnId);
      this.pendingReturnId = undefined;
      if (s2) {
        this.lastAttached = s2;
        this.cursor = s2;
        this.rearrange(this.p.now(), false);
        this.draw();
      }
    }
    // Last attached が出ないとき(対象外になったとき)は、ラダーの最上位を選ぶ。
    if (this.cursor === null || !this.entries().some(e => e.sid === this.cursor)) {
      this.cursor = this.arranged?.upNext[0]?.positionSid ?? null;
      this.draw();
    }
  }

  private pendingReturnId: string | undefined;

  private async request(r: string, clients: {tty: string; session: string; termname: string}[]): Promise<void> {
    const parts = r.split(' ');
    const kind = parts[0];
    if (kind === 'key') {
      const [, action, session = '', tty = ''] = parts;
      const pressed = clients.find(c => c.tty === tty);
      await this.attachKey(action as KeyAction, session, tty, pressed?.termname ?? '', clients);
    } else if (kind === 'agentview') {
      const id = parts[1] ?? '';
      const tty = await this.mainTty();
      const main = clients.find(c => c.tty === tty);
      if (main && main.session === id && tty) await this.p.tmux.switchClient(tty, LIST);
      await this.p.tmux.killSession(id);
      if (this.attached?.id === id) await this.returned(this.attached);
    } else if (kind === 'focus') {
      const wbTty = await this.p.tmux.option('@wn_wb_tty');
      if (parts[1] === wbTty) await this.refreshGuidePlace();
    } else if (kind === 'wbcreate') {
      const id = parts[1] ?? '';
      const sid = this.sidOfId(id);
      if (sid) await this.makeWorkbench(sid, {from: 'guide'});
    } else if (kind === 'open') {
      const [, token = '', idx = '', tty = ''] = parts;
      const items = this.menuChoices.get(token);
      this.menuChoices.delete(token);
      const it = items?.[Number(idx)];
      if (it?.target) {
        const res = await this.p.open(it.target);
        await this.p.tmux.display(
          tty,
          res.code === 0
            ? `Opened ${it.what}.`
            : `open failed: ${(res.stderr || res.stdout || res.error || '').trim()}`,
          3000,
        );
      }
    }
  }

  /** 作業台の画面か claude の画面の、押したセッションのセッションの sessionId。 */
  private async targetOfPressed(session: string): Promise<string | undefined> {
    if (session.startsWith('sh-')) return this.sidOfId(session.slice(3));
    if (session === GUIDE) {
      const g = this.guideTarget;
      return g ?? undefined;
    }
    if (session === LIST) return undefined;
    return this.sidOfId(session) ?? (this.attached?.id === session ? this.attached.sid : undefined);
  }

  private async attachKey(
    action: KeyAction,
    session: string,
    tty: string,
    termname: string,
    clients: {tty: string; session: string}[],
  ): Promise<void> {
    const mainTty = await this.mainTty();
    const main = clients.find(c => c.tty === mainTty);
    const fromWb = tty !== mainTty;
    const sid = await this.targetOfPressed(session);
    const idOfSession = session.startsWith('sh-') ? session.slice(3) : session === GUIDE ? undefined : session;

    if (action === 'ext') {
      await this.externalMenu(sid, idOfSession, tty);
      return;
    }
    if (action === 'wb') {
      if (sid) await this.makeWorkbench(sid, {from: 'attach', tty, ghostty: /ghostty/i.test(termname)});
      else if (idOfSession)
        await this.p.tmux.display(tty, 'This session is not in the list yet. Try again in a moment.', 3000);
      return;
    }
    if (action === 'next') {
      await this.next(tty, main, fromWb);
      return;
    }
    // 一覧に戻るキー
    if (!main) {
      await this.p.tmux.display(tty, 'The list is not open. Run "whatnext" to open it.', 3000);
      return;
    }
    if (main.session !== LIST && mainTty) {
      await this.p.tmux.switchClient(mainTty, LIST);
      if (this.attached) await this.returned(this.attached);
    }
    const target = sid ?? (fromWb ? undefined : (this.lastAttached ?? undefined));
    this.mode = {kind: 'list'};
    switch (action) {
      case 'back':
        break;
      case 'hold':
        if (target) this.hold(target);
        break;
      case 'stop':
        if (target) {
          this.cursor = target;
          await this.ctrlX(target);
        }
        break;
      case 'new':
        this.openDirPicker({firstRepo: target ? this.mainRootOf(target) : undefined});
        break;
      case 'wait':
        if (target) this.openWait(target);
        break;
    }
    this.draw();
  }

  /** `ctrl+q ctrl+j`: Up next の先頭のセッションへ、一覧を経由せずに移る。 */
  private async next(tty: string, main: {tty: string; session: string} | undefined, fromWb: boolean): Promise<void> {
    if (!main) {
      await this.p.tmux.display(tty, 'The list is not open. Run "whatnext" to open it.', 3000);
      return;
    }
    let current: string | undefined;
    if (main.session === LIST) current = fromWb ? (this.lastAttached ?? undefined) : undefined;
    else current = this.attached?.sid ?? this.sidOfId(main.session);
    const saved = this.lastAttached;
    if (current) this.lastAttached = current;
    this.rearrange(this.p.now(), false);
    const target = this.arranged?.upNext
      .map(g => g.positionSid)
      .find(s => {
        const r = this.rowOf(s);
        return s !== current && r?.kind === 'background' && r.id && !this.isDeleting(s);
      });
    if (!target) {
      this.lastAttached = saved;
      this.rearrange(this.p.now(), false);
      await this.p.tmux.display(tty, 'No other session in Up next.', 2000);
      return;
    }
    const att = this.attached;
    if (att?.sid && att.snapshot) this.leftSnapshots.push({sid: att.sid, snapshot: att.snapshot});
    this.attached = null;
    this.cursor = current ?? target;
    await this.attach(target);
    void this.fetchUsage();
    void this.refresh();
  }

  // ---- 作業台 ----

  private guideTarget: string | null = null;

  scheduleWbSync(): void {
    this.wbTimer?.cancel();
    this.wbTimer = this.p.setTimer(() => {
      this.wbChain = this.wbChain.then(() => this.syncWorkbench()).catch(() => {});
    }, 60);
  }

  /** 作業台の画面を、whatnext の画面が映すものに合わせて切り替える。 */
  private async syncWorkbench(forceId?: string): Promise<void> {
    const wbTty = await this.p.tmux.option('@wn_wb_tty');
    if (!wbTty) return;
    const clients = await this.p.tmux.clients();
    const wb = clients.find(c => c.tty === wbTty);
    if (!wb) return;
    let sid: string | null | undefined;
    let id: string | undefined = forceId;
    if (!id) {
      const mainTty = await this.mainTty();
      const main = clients.find(c => c.tty === mainTty);
      if (!main) return;
      if (main.session === LIST) sid = this.cursor;
      else if (main.session.startsWith('trust-')) return;
      else id = main.session;
    }
    if (id) sid = this.sidOfId(id) ?? (this.attached?.id === id ? this.attached.sid : undefined);
    const row = this.rowOf(sid);
    if (!id) id = row?.id;
    const sessions = new Set(await this.p.tmux.sessions());
    const closed = await this.p.tmux.option('@wn_closed');
    this.guideTarget = sid ?? null;
    const name = row ? rowName(row) : (id ?? '');
    let info: object;
    if (!row && !id) info = {text: ['No session selected.']};
    else if (row && (row.kind === 'interactive' || !row.id))
      info = {text: [`${name} is an interactive session. It has no workbench.`]};
    else {
      const path = tildify(row?.cwd ?? '', this.p.home);
      info = {
        id,
        text: [
          ...(closed && closed === id ? ['Workbench closed.', ''] : []),
          `No workbench for ${name} yet.`,
          `Enter: open a shell in ${path}`,
        ],
      };
    }
    if (closed && closed !== id) await this.p.tmux.unsetOption('@wn_closed');
    const target = id && sessions.has(`sh-${id}`) ? `sh-${id}` : GUIDE;
    if (target === GUIDE) {
      const json = JSON.stringify(info);
      if ((await this.p.tmux.option('@wn_guide')) !== json) {
        await this.p.tmux.setOption('@wn_guide', json);
        await this.p.tmux.setSessionName(GUIDE, name);
        await this.p.tmux.signalGuide();
      }
    }
    if (wb.session !== target) await this.p.tmux.switchClient(wbTty, target);
  }

  private async refreshGuidePlace(): Promise<void> {
    const sid = this.guideTarget;
    if (!sid) return;
    const res = await this.p.readAgents();
    if (!res.ok || !this.rows) return;
    const fresh =
      res.rows.find(r => r.sessionId === sid && r.pid !== undefined) ?? res.rows.find(r => r.sessionId === sid);
    const row = this.rows.find(r => r.sessionId === sid);
    if (fresh && row && fresh.cwd !== row.cwd) {
      row.cwd = fresh.cwd;
      await this.p.tmux.setOption('@wn_guide', '');
      await this.syncWorkbench();
    }
  }

  /** 作業台を作る(`ctrl+q ctrl+w`、一覧の `w`、案内の `Enter`)。 */
  private async makeWorkbench(
    sid: string,
    how: {from: 'list' | 'attach' | 'guide'; tty?: string; ghostty?: boolean},
  ): Promise<void> {
    const row = this.rowOf(sid);
    const say = async (text: string) => {
      if (how.from === 'list') this.flash(text);
      else if (how.tty) await this.p.tmux.display(how.tty, text, 3000);
    };
    if (!row || this.isDeleting(sid)) return;
    const name = rowName(row);
    if (row.kind === 'interactive' || !row.id) {
      await say(`${name} is an interactive session. It has no workbench.`);
      return;
    }
    const id = row.id;
    const session = `sh-${id}`;
    const sessions = new Set(await this.p.tmux.sessions());
    const existed = sessions.has(session);
    if (!existed) {
      // 作る直前に `--json` を読み直し、その時点の `cwd` で開く。
      const res = await this.p.readAgents();
      let cwd = row.cwd;
      if (res.ok) {
        const fresh = dedupe(res.rows).find(r => r.sessionId === sid);
        if (fresh) cwd = fresh.cwd;
      }
      const ok = await this.p.tmux.createWorkbench(id, cwd, name);
      if (!ok) {
        await say(`Could not create a workbench for ${name}.`);
        return;
      }
    }
    await this.p.tmux.unsetOption('@wn_closed');
    const wbTty = await this.p.tmux.option('@wn_wb_tty');
    const clients = await this.p.tmux.clients();
    const wbOpen = !!wbTty && clients.some(c => c.tty === wbTty);
    this.scheduleWbSync();
    if (how.from === 'guide') return;
    let ghostty = how.ghostty ?? false;
    if (how.from === 'list') {
      const mainTty = await this.mainTty();
      ghostty = /ghostty/i.test(clients.find(c => c.tty === mainTty)?.termname ?? '');
    }
    if (ghostty) {
      if (wbOpen) {
        await this.p.ghosttyFocus();
        return;
      }
      const r = await this.p.ghosttySplit();
      if (r === 'split') return;
    }
    if (existed) await say(`Workbench already exists for ${name}.`);
    else if (!wbOpen) await say('Workbench created. Run "whatnext workbench" in a split to see it.');
  }

  // ---- 外のアプリで開く ----

  private extItems(cwd: string, place: Place | undefined, pr: PullRequest | undefined): ExtItem[] {
    const root = place?.checkoutRoot ?? cwd;
    const home = this.p.home;
    const items: ExtItem[] = [];
    if (pr)
      items.push({label: `Pull request #${pr.number} on GitHub`, target: pr.url, what: `pull request #${pr.number}`});
    items.push({
      label: `VS Code: ${tildify(root, home)}`,
      target: `vscode://file${root}/?windowId=_blank`,
      what: `${tildify(root, home)} in VS Code`,
    });
    const dev = pr ? vscodeDevUrl(pr.url) : undefined;
    if (pr && dev)
      items.push({
        label: `Pull request #${pr.number} on vscode.dev`,
        target: dev,
        what: `pull request #${pr.number} on vscode.dev`,
      });
    if (!pr) items.push({label: 'No pull request for this session.'});
    return items;
  }

  private openExt(sid: string): void {
    const row = this.rowOf(sid);
    if (!row || this.isDeleting(sid)) return;
    const items = this.extItems(row.cwd, this.places.get(row.cwd), this.prOf(row.cwd));
    this.mode = {kind: 'ext', sid, items, sel: 0};
  }

  private extKey(str: string | undefined, k: Key, md: Extract<Mode, {kind: 'ext'}>): void {
    const selectable = md.items.map((it, i) => (it.target ? i : -1)).filter(i => i >= 0);
    if (k.name === 'escape') this.mode = {kind: 'list'};
    else if (k.name === 'up' || k.name === 'down') {
      const pos = selectable.indexOf(md.sel);
      const next = pos + (k.name === 'up' ? -1 : 1);
      if (next >= 0 && next < selectable.length) md.sel = selectable[next] as number;
    } else if (k.name === 'return') void this.openItem(md.items[md.sel]);
    else if (str && /^[1-9]$/.test(str)) {
      const it = md.items[Number(str) - 1];
      if (it?.target) void this.openItem(it);
    }
    this.draw();
  }

  private async openItem(it: ExtItem | undefined): Promise<void> {
    if (!it?.target) return;
    this.mode = {kind: 'list'};
    const r = await this.p.open(it.target);
    this.flash(r.code === 0 ? `Opened ${it.what}.` : `open failed: ${(r.stderr || r.stdout || r.error || '').trim()}`);
  }

  /** `ctrl+q ctrl+e`: 押したときに `--json` を読み直し、tmux のメニューで出す。 */
  private async externalMenu(sid: string | undefined, id: string | undefined, tty: string): Promise<void> {
    const res = await this.p.readAgents();
    let row: AgentRow | undefined;
    if (res.ok) {
      const rows = dedupe(res.rows);
      row = rows.find(r => (sid ? r.sessionId === sid : r.id === id));
    }
    row ??= this.rowOf(sid);
    if (!row) return;
    const place = await this.p.place(row.cwd);
    const pr =
      place.git && place.branch && place.nonDefault ? await this.p.pullRequest(row.cwd, place.branch) : undefined;
    const items = this.extItems(row.cwd, place, pr);
    const token = String(++this.menuSeq);
    this.menuChoices.set(token, items);
    let n = 0;
    this.p.tmux.menu(
      tty,
      `Show ${rowName(row)} in:`,
      items.map((it, i) =>
        it.target
          ? {label: it.label, key: String(++n), command: this.p.tmux.reqCommand(`open ${token} ${i} "#{client_tty}"`)}
          : {label: it.label},
      ),
    );
  }

  // ---- 保留 ----

  private hold(sid: string): void {
    if (this.isDeleting(sid)) return;
    if (this.holds.has(sid)) {
      this.holds.delete(sid);
      this.rearrange(this.p.now(), false);
      this.cursor = sid;
      this.flash(`${this.nameOf(sid)} is back in the list.`);
      return;
    }
    this.mode = {kind: 'hold', sid, value: ''};
    this.draw();
  }

  private putOnHold(sid: string, reason: string): void {
    const list = this.entries();
    const i = list.findIndex(e => e.sid === sid);
    let moving = [sid];
    if (this.arranged && i >= 0 && list[i]?.depth === 0) moving = subtreeOf(this.arranged, sid);
    const after = list.slice(i + 1).find(e => !moving.includes(e.sid));
    const before = [...list.slice(0, Math.max(0, i))].reverse().find(e => !moving.includes(e.sid));
    this.holds.set(sid, reason);
    this.rearrange(this.p.now(), false);
    this.cursor = after?.sid ?? before?.sid ?? sid;
    this.flash(`Put ${this.nameOf(sid)} on hold. It comes back when you attach and work on it, or press h on it.`);
    this.scheduleWbSync();
  }

  // ---- 待ち先 ----

  private link(waiter: string, target: string): void {
    const cur = this.waits.get(waiter) ?? [];
    if (!cur.includes(target)) this.waits.set(waiter, [...cur, target]);
  }

  private waiterOf(sid: string): string | undefined {
    for (const [w, ts] of this.waits) if (ts.includes(sid)) return w;
    return undefined;
  }

  private ancestors(sid: string): Set<string> {
    const out = new Set<string>();
    let cur = this.waiterOf(sid);
    while (cur && !out.has(cur)) {
      out.add(cur);
      cur = this.waiterOf(cur);
    }
    return out;
  }

  private waitOptions(
    waiter: string,
    filter: string,
  ): {label: string; detail?: string; marked?: boolean; sid?: string}[] {
    const anc = this.ancestors(waiter);
    const mine = this.waits.get(waiter) ?? [];
    const cands = this.entries().filter(e => {
      if (e.sid === waiter || anc.has(e.sid)) return false;
      const w = this.waiterOf(e.sid);
      return w === undefined || w === waiter;
    });
    const items = cands.map(e => ({
      name: e.name,
      path: e.row.cwd,
      sid: e.sid,
      detail: `${e.status} · ${this.places.get(e.row.cwd)?.repo ?? basename(e.row.cwd)}`,
    }));
    const idx = filterIndexes(items, filter);
    return [
      {label: 'New session'},
      ...idx.map(i => {
        const it = items[i] as (typeof items)[number];
        return {label: it.name, detail: it.detail, marked: mine.includes(it.sid), sid: it.sid};
      }),
    ];
  }

  private openWait(waiter: string): void {
    if (this.isDeleting(waiter)) return;
    this.mode = {kind: 'wait', waiter, filter: '', sel: 0};
  }

  private waitKey(str: string | undefined, k: Key, md: Extract<Mode, {kind: 'wait'}>): void {
    const opts = this.waitOptions(md.waiter, md.filter);
    if (k.name === 'escape') this.mode = {kind: 'list'};
    else if (k.name === 'up') md.sel = Math.max(0, md.sel - 1);
    else if (k.name === 'down') md.sel = Math.min(opts.length - 1, md.sel + 1);
    else if (k.name === 'backspace') {
      md.filter = [...md.filter].slice(0, -1).join('');
      md.sel = md.filter ? Math.min(1, this.waitOptions(md.waiter, md.filter).length - 1) : 0;
    } else if (k.name === 'return') {
      const o = opts[md.sel];
      if (md.sel === 0) {
        this.openDirPicker({firstRepo: this.mainRootOf(md.waiter), linkTo: md.waiter});
      } else if (o?.sid) {
        this.mode = {kind: 'list'};
        const cur = this.waits.get(md.waiter) ?? [];
        if (cur.includes(o.sid))
          this.waits.set(
            md.waiter,
            cur.filter(t => t !== o.sid),
          );
        else this.link(md.waiter, o.sid);
        if ((this.waits.get(md.waiter) ?? []).length === 0) this.waits.delete(md.waiter);
        this.rearrange(this.p.now(), false);
      }
    } else if (str && !k.ctrl && !k.meta && str >= ' ') {
      md.filter += str;
      md.sel = Math.min(1, this.waitOptions(md.waiter, md.filter).length - 1);
    }
    this.draw();
  }

  // ---- 新しいセッション ----

  private async candidates(first?: string): Promise<Candidate[]> {
    const paths: string[] = [];
    if (first) paths.push(first);
    paths.push(this.p.startDir);
    for (const r of this.rows ?? []) paths.push(this.places.get(r.cwd)?.mainRoot ?? r.cwd);
    paths.push(...(await this.p.ghqList()));
    const uniq = [...new Set(paths.filter(Boolean))];
    const names = displayNames(uniq);
    return uniq.map((path, i) => ({name: names[i] as string, path}));
  }

  private dirIndexes(md: {filter: string; cands: Candidate[]}): number[] {
    return filterIndexes(md.cands, md.filter);
  }

  private openDirPicker(flow: NewFlow): void {
    this.mode = {kind: 'dir', filter: '', sel: 0, cands: [], flow};
    void this.candidates(flow.firstRepo).then(cands => {
      if (this.mode.kind === 'dir' && this.mode.flow === flow) {
        this.mode.cands = cands;
        this.draw();
      }
    });
    this.draw();
  }

  private dirKey(str: string | undefined, k: Key, md: Extract<Mode, {kind: 'dir'}>): void {
    const idx = this.dirIndexes(md);
    const count = idx.length + 1;
    if (k.name === 'escape') this.mode = {kind: 'list'};
    else if (k.name === 'up') md.sel = Math.max(0, md.sel - 1);
    else if (k.name === 'down') md.sel = Math.min(count - 1, md.sel + 1);
    else if (k.name === 'backspace') {
      md.filter = [...md.filter].slice(0, -1).join('');
      md.sel = 0;
    } else if (k.name === 'return') {
      if (md.sel >= idx.length)
        this.mode = {kind: 'other', value: md.filter, flow: md.flow, cands: md.cands, filter: md.filter};
      else {
        const c = md.cands[idx[md.sel] as number] as Candidate;
        this.mode = {kind: 'model', sel: 0, dir: c.path, flow: md.flow};
      }
    } else if (str && !k.ctrl && !k.meta && str >= ' ') {
      md.filter += str;
      md.sel = 0;
    }
    this.draw();
  }

  private async otherDone(md: Extract<Mode, {kind: 'other'}>): Promise<void> {
    const v = md.value.trim();
    const dir = v === '' ? this.p.startDir : expandHome(v, this.p.home);
    if (!(await this.p.isDirectory(dir))) {
      md.error = `Not a directory: ${dir}`;
      this.draw();
      return;
    }
    this.mode = {kind: 'model', sel: 0, dir, flow: md.flow};
    this.draw();
  }

  private async launch(dir: string, model: string | undefined, flow: NewFlow): Promise<void> {
    const startedAt = this.p.now();
    this.mode = {kind: 'starting', dir, model, startedAt};
    let ticking = true;
    const tick = () => {
      if (!ticking) return;
      this.draw();
      this.p.setTimer(tick, 1000);
    };
    this.p.setTimer(tick, 1000);
    this.draw();
    const r = await this.p.launch(dir, model);
    ticking = false;
    const out = stripControl(`${r.stdout}\n${r.stderr}`);
    if (/Workspace not trusted/i.test(out)) {
      await this.startTrust(dir, model, flow);
      return;
    }
    const m = /backgrounded\s*·\s*([0-9a-f]{8})/.exec(out);
    if (!m) {
      const lines = out.trim().split('\n').filter(Boolean).slice(-8);
      this.mode = {kind: 'pressKey', lines: [`claude --bg did not start a session:`, ...lines]};
      this.draw();
      return;
    }
    const id = m[1] as string;
    if (flow.linkTo) this.pendingLinks.push({waiter: flow.linkTo, id});
    const ok = await this.p.tmux.ensureClaudeSession(id, dir, this.p.size());
    this.mode = {kind: 'list'};
    if (!ok) {
      this.flash(`Could not attach to ${id}.`);
      void this.refresh();
      return;
    }
    await this.p.tmux.setSummary(id, id);
    this.attached = {id};
    const tty = await this.mainTty();
    await this.syncWorkbench(id);
    if (tty) await this.p.tmux.switchClient(tty, id);
    this.draw();
  }

  private async startTrust(dir: string, model: string | undefined, flow: NewFlow): Promise<void> {
    const session = await this.p.tmux.newTrustSession(dir);
    const tty = await this.mainTty();
    if (!session || !tty) {
      this.mode = {kind: 'list'};
      this.flash(`Not trusted: ${dir}`);
      return;
    }
    this.trust = {dir, session, flow, model};
    await this.p.tmux.switchClient(tty, session);
    const poll = async () => {
      const t = this.trust;
      if (!t || t.session !== session) return;
      if (await this.p.trusted(dir)) {
        this.trust = null;
        await this.p.tmux.switchClient(tty, LIST);
        await this.p.tmux.killSession(session);
        await this.launch(dir, model, flow);
        return;
      }
      const alive = (await this.p.tmux.sessions()).includes(session);
      if (!alive) {
        this.trust = null;
        this.mode = {kind: 'list'};
        this.flash(`Not trusted: ${dir}`);
        return;
      }
      this.p.setTimer(() => void poll(), 500);
    };
    this.p.setTimer(() => void poll(), 500);
  }

  // ---- 停止と削除 ----

  private async ctrlX(sid: string): Promise<void> {
    const now = this.p.now();
    if (this.moved && now < this.moved.until) {
      this.flash(`Ctrl+X ignored: ${this.moved.name} left the list and the selection moved.`);
      return;
    }
    this.moved = null;
    const row = this.rowOf(sid);
    if (!row?.id || row.kind === 'interactive' || this.isDeleting(sid)) return;
    const id = row.id;
    if (this.arm && this.arm.sid === sid && (now < this.arm.until || this.transient.get(sid) === 'stopping')) {
      this.arm = null;
      this.messages = [];
      await this.deleteFlow(sid);
      return;
    }
    this.arm = {sid, until: now + ARM_MS};
    const tier = this.arranged?.tiers.get(sid);
    if (tier === 'stopped') {
      this.flash('Press Ctrl+X again within 2s to delete.');
      return;
    }
    this.transient.set(sid, 'stopping');
    this.messages = [];
    this.draw();
    const r = await this.p.stop(id);
    if (this.transient.get(sid) === 'stopping') this.transient.delete(sid);
    await this.p.tmux.killSession(id);
    if (this.attached?.id === id) this.attached = null;
    if (this.isDeleting(sid)) return;
    if (r.code !== 0) {
      const out = (r.stdout || r.stderr || r.error || '').trim().split('\n')[0] ?? '';
      this.flash(`Stop failed: ${out} (Ctrl+X again to delete)`);
    } else if (this.arm?.sid === sid) this.flash(`Stopped ${rowName(row)}. Press Ctrl+X again within 2s to delete.`);
    void this.refresh();
  }

  private async deleteFlow(sid: string): Promise<void> {
    const targets = this.arranged ? subtreeOf(this.arranged, sid).slice(1) : [];
    let cascade = false;
    if (targets.length > 0) {
      const names = targets.map(t => this.nameOf(t)).join(', ');
      cascade = await this.confirm(
        `Also delete ${targets.length} ${targets.length === 1 ? 'session' : 'sessions'} this one was waiting for? (${names}) [y/N]`,
        false,
      );
    }
    this.transient.set(sid, 'deleting');
    if (cascade) for (const t of targets) this.transient.set(t, 'deleting');
    this.draw();
    const ok = await this.deleteOne(sid, false);
    if (cascade) {
      if (ok) for (const t of targets) await this.deleteOne(t, true);
      else for (const t of targets) this.transient.delete(t);
    }
    this.draw();
    await this.refresh();
    for (const [s, v] of this.transient) if (v === 'deleting' && !this.rowOf(s)) this.transient.delete(s);
    this.draw();
  }

  private async deleteOne(sid: string, stopFirst: boolean): Promise<boolean> {
    const row = this.rowOf(sid);
    const fail = (msg?: string) => {
      this.transient.delete(sid);
      if (msg) this.flash(msg);
      this.draw();
      return false;
    };
    if (!row?.id) return fail();
    const id = row.id;
    const name = rowName(row);
    const running = (await this.p.tmux.running()).get(id) ?? [];
    if (running.length > 0) {
      const ok = await this.confirm(
        `Delete ${name} and stop running commands? ${name}: ${running.join(', ')} [y/N]`,
        false,
      );
      if (!ok) return fail();
    }
    // 止めている最中なら終わるのを待つ。
    for (let i = 0; i < 300 && this.transient.get(sid) === 'stopping'; i++) await this.sleep(100);
    this.transient.set(sid, 'deleting');
    this.draw();
    if (stopFirst && row.pid !== undefined) await this.p.stop(id);
    let discard: string | undefined;
    const deadline = this.p.now() + 45_000;
    for (;;) {
      const r = await this.p.remove(id, discard);
      if (r.code === 0) {
        await this.p.tmux.killSession(`sh-${id}`);
        await this.p.tmux.killSession(id);
        if (this.attached?.id === id) this.attached = null;
        this.forgetSession(sid);
        return true;
      }
      const out = `${r.stdout}\n${r.stderr}`.trim();
      const unpushed = /(\d+) unpushed commit/.exec(out);
      const value = /--discard-unpushed[ =](\S+)/.exec(out);
      if (unpushed && value && !discard) {
        const n = Number(unpushed[1]);
        const ok = await this.confirm(
          `Discard ${n} unpushed ${n === 1 ? 'commit' : 'commits'} and delete session ${id}? [y/N]`,
          false,
        );
        if (!ok) return fail();
        discard = (value[1] as string).replace(/[“”"'`]/g, '');
        continue;
      }
      const isLock = /^kept\b/.test(out) && !/uncommitted|unpushed/i.test(out);
      if (isLock && this.p.now() < deadline) {
        await this.sleep(1000);
        continue;
      }
      return fail(out.split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' '));
    }
  }

  private forgetSession(sid: string): void {
    this.holds.delete(sid);
    this.waits.delete(sid);
    for (const [w, ts] of [...this.waits])
      if (ts.includes(sid))
        this.cutWaits(
          w,
          ts.filter(t => t !== sid),
        );
    this.save();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(res => this.p.setTimer(res, ms));
  }

  private confirm(text: string, defaultYes: boolean): Promise<boolean> {
    return new Promise(resolve => {
      const prev = this.mode;
      this.mode = {
        kind: 'confirm',
        text,
        defaultYes,
        resolve: yes => {
          if (this.mode.kind === 'list' && prev.kind !== 'confirm') this.mode = {kind: 'list'};
          resolve(yes);
        },
      };
      this.draw();
    });
  }

  // ---- 終了 ----

  private async quit(): Promise<void> {
    const running = await this.p.tmux.running();
    const all = [...running].flatMap(([id, cmds]) => cmds.map(c => ({id, c})));
    if (all.length > 0) {
      const list = [...running].map(([id, cmds]) => `${this.nameOfId(id)}: ${cmds.join(', ')}`).join(', ');
      const ok = await this.confirm(
        `Quit and stop ${all.length} running ${all.length === 1 ? 'command' : 'commands'}? ${list} [y/N]`,
        false,
      );
      if (!ok) return;
    }
    this.quitting = true;
    this.refreshTimer?.cancel();
    this.p.exit();
  }
}
