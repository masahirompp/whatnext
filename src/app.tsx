import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React, { useEffect, useReducer } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import {
  cascadeTargets,
  effectiveTiers,
  flatOrder,
  formatWaiting,
  group,
  pruneWaits,
  tierLabel,
  toSessions,
  trackSince,
  unfinishedTargets,
  wouldCycle,
  type RawRow,
  type Row,
  type Session,
  type Tier,
  type Tracked,
  type Waits,
} from './model.js';
import { launchBg, listAgents, removeSession, runInTerminal, stopSession } from './claude.js';
import { fetchPR, gitInfo, type Where } from './where.js';
import { fetchUsage, type UsageItem } from './usage.js';
import { otelFor } from './otel.js';
import { displayNames, filterItems } from './filter.js';
import { run } from './exec.js';

// ---------------- state (mutable, read by key handlers) ----------------

type Mode =
  | { kind: 'list' }
  | { kind: 'hold'; sid: string; text: string }
  | { kind: 'external'; sid: string; index: number }
  | { kind: 'wait'; sid: string; query: string; index: number }
  | {
      kind: 'new';
      step: 'dir' | 'dirOther' | 'model' | 'modelOther' | 'launching' | 'failed';
      query: string;
      index: number;
      dirs: string[];
      dir?: string;
      modelIndex: number;
      model: string;
      waiter?: string;
      startedAt?: number;
      output?: string;
      dirError?: string;
    }
  | { kind: 'confirm'; text: string; resolve: (yes: boolean) => void };

const S = {
  rawSessions: [] as Session[],
  allSids: new Set<string>(),
  rows: [] as Row[],
  tracked: new Map<string, Tracked>(),
  lastRefreshAt: undefined as number | undefined,
  refreshing: false,
  loaded: false,
  error: undefined as string | undefined,
  waits: new Map() as Waits,
  doneNotes: new Map<string, string[]>(),
  pendingWait: undefined as { waiter: string; id: string } | undefined,
  holds: new Map<string, string>(),
  lastAttached: undefined as string | undefined,
  lastAttachedId: undefined as string | undefined,
  selected: undefined as string | undefined,
  where: new Map<string, Where>(),
  usage: undefined as UsageItem[] | undefined,
  message: undefined as { text: string; color?: string } | undefined,
  flash: undefined as string | undefined,
  mode: { kind: 'list' } as Mode,
  pendingDelete: undefined as { sid: string; id: string; name: string; at: number; stopping: boolean } | undefined,
  busy: false, // attached or running a blocking action
  ghqDirs: undefined as string[] | undefined,
};

let rerender = () => {};

// ---------------- derivation ----------------

function nameOf(sid: string) {
  return S.rawSessions.find((s) => s.sid === sid)?.name ?? sid.slice(0, 8);
}

function recompute(prevRefreshAt: number | undefined) {
  const visible = S.rawSessions;
  const tiers = effectiveTiers(visible, S.waits);
  // "↳ <B> done": the waiter left Waiting because every target finished.
  for (const [w, ts] of S.waits) {
    if (!tiers.has(w)) continue;
    const all = unfinishedTargets(w, S.waits, tiers).length === 0;
    if (S.tracked.get(w)?.tier === 'Waiting' && tiers.get(w) !== 'Waiting' && all) S.doneNotes.set(w, [...ts].map(nameOf));
    if (!all) S.doneNotes.delete(w);
  }
  S.tracked = trackSince(S.tracked, tiers, prevRefreshAt, (sid) => otelFor(sid)?.lastEventAt);
  S.rows = visible.map((s) => ({ ...s, tier: tiers.get(s.sid)!, since: S.tracked.get(s.sid)?.since ?? null }));
}

function groups() {
  return group(S.rows, S.lastAttached, S.holds);
}

function ladderTop() {
  const g = groups();
  return (g.ladder[0] ?? g.last ?? g.hold[0])?.sid;
}

function selectedRow() {
  return S.rows.find((r) => r.sid === S.selected);
}

async function refresh(opts: { manual?: boolean } = {}) {
  if (S.refreshing) return;
  S.refreshing = true;
  S.flash = undefined;
  rerender();
  const prevRefreshAt = S.lastRefreshAt;
  let raw: RawRow[] | undefined;
  try {
    raw = await listAgents();
    S.error = undefined;
  } catch (e) {
    S.error = (e as Error).message;
  }
  const now = Date.now();
  if (raw) {
    const { visible, all } = toSessions(raw);
    rememberIds(raw);
    S.rawSessions = visible;
    S.allSids = all;
    if (S.pendingWait) {
      const t = raw.find((r) => r.id === S.pendingWait!.id)?.sessionId;
      if (t && !wouldCycle(S.waits, S.pendingWait.waiter, t)) {
        const set = S.waits.get(S.pendingWait.waiter) ?? new Set();
        set.add(t);
        S.waits.set(S.pendingWait.waiter, set);
        S.pendingWait = undefined;
      }
    }
    if (S.lastAttachedId) {
      const t = raw.find((r) => r.id === S.lastAttachedId)?.sessionId;
      if (t) {
        S.lastAttached = t;
        S.selected = t;
      }
      S.lastAttachedId = undefined;
    }
    recompute(prevRefreshAt ?? undefined);
    pruneWaits(S.waits, all);
    const visibleSids = new Set(visible.map((s) => s.sid));
    for (const sid of [...S.holds.keys()]) if (!visibleSids.has(sid)) S.holds.delete(sid);
    for (const sid of [...S.doneNotes.keys()]) if (!visibleSids.has(sid)) S.doneNotes.delete(sid);
    if (!S.selected || !visibleSids.has(S.selected)) S.selected = ladderTop();
    S.loaded = true;
    S.lastRefreshAt = now;
    void updateWhere(visible);
  } else {
    S.rawSessions = [];
    S.rows = [];
    S.loaded = true;
    S.lastRefreshAt = now;
  }
  S.refreshing = false;
  if (opts.manual) {
    S.flash = 'Refreshed.';
    setTimeout(() => {
      if (S.flash === 'Refreshed.') S.flash = undefined;
      rerender();
    }, 2000);
  }
  rerender();
}

async function updateWhere(visible: Session[]) {
  const cwds = [...new Set(visible.map((s) => s.cwd).filter(Boolean))];
  await Promise.all(
    cwds.map(async (cwd) => {
      const w = await gitInfo(cwd);
      const prev = S.where.get(cwd);
      // Keep the PR we already know for the same branch until the new one arrives.
      if (prev && prev.branch === w.branch) w.pr = prev.pr;
      S.where.set(cwd, w);
      rerender();
      if (w.branch) {
        const pr = await fetchPR(cwd, w.branch);
        const cur = S.where.get(cwd);
        if (cur && cur.branch === w.branch) cur.pr = pr;
      } else {
        w.pr = null;
      }
      rerender();
    }),
  );
}

async function refreshUsage() {
  const u = await fetchUsage();
  S.usage = u ?? undefined;
  rerender();
}

// ---------------- actions ----------------

function setMessage(text: string, color?: string) {
  S.message = { text, color };
  rerender();
}

type Suspend = (cb: () => Promise<void>) => Promise<void>;

async function attach(suspend: Suspend, row: { sid: string; id: string }) {
  const before = S.rawSessions.find((s) => s.sid === row.sid);
  const startedAt = Date.now();
  S.busy = true;
  await suspend(async () => {
    await runInTerminal(['attach', row.id]);
  });
  S.busy = false;
  await afterAttach(row.sid, before, startedAt);
}

async function afterAttach(sid: string | undefined, before: Session | undefined, startedAt: number) {
  if (sid) {
    S.lastAttached = sid;
    S.selected = sid;
    S.doneNotes.delete(sid);
  }
  void refreshUsage();
  await refresh();
  if (sid && S.holds.has(sid)) {
    const after = S.rawSessions.find((s) => s.sid === sid);
    const o = otelFor(sid);
    const worked =
      !after ||
      !before ||
      after.state !== before.state ||
      after.status !== before.status ||
      after.waitingFor !== before.waitingFor ||
      (o?.lastEventAt !== undefined && o.lastEventAt > startedAt);
    if (worked) S.holds.delete(sid);
  }
  if (sid && !S.rows.some((r) => r.sid === sid)) S.selected = ladderTop();
  rerender();
}

function confirm(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    S.mode = { kind: 'confirm', text, resolve };
    rerender();
  });
}

async function deleteOne(id: string, name: string): Promise<boolean> {
  let outcome = await removeSession(id);
  const until = Date.now() + 20000;
  while (outcome.kind === 'locked' && Date.now() < until) {
    setMessage(`Waiting for ${name} to exit before deleting...`);
    await new Promise((r) => setTimeout(r, 1000));
    outcome = await removeSession(id);
  }
  if (outcome.kind === 'unpushed') {
    const n = outcome.count;
    const yes = await confirm(`Discard ${n} unpushed commit${n === 1 ? '' : 's'} and delete session ${id}? [y/N]`);
    if (!yes) {
      setMessage(`Kept ${name}.`);
      return false;
    }
    outcome = await removeSession(id, outcome.discard);
  }
  if (outcome.kind === 'removed') return true;
  setMessage(`Could not delete ${name}: ${'message' in outcome ? outcome.message : ''}`, 'red');
  return false;
}

async function deleteWithCascade(sid: string, id: string, name: string) {
  S.busy = true;
  try {
    const cascade = cascadeTargets(S.waits, sid)
      .map((t) => ({ sid: t, raw: S.rawSessions.find((s) => s.sid === t), name: nameOf(t) }))
      .filter((t) => t.sid);
    const idOf = (t: string) => allRawIds.get(t);
    let alsoDelete = false;
    const deletable = cascade.filter((t) => idOf(t.sid));
    if (deletable.length) {
      const n = deletable.length;
      alsoDelete = await confirm(
        `Also delete ${n} session${n === 1 ? '' : 's'} this one was waiting for? (${deletable.map((t) => t.name).join(', ')}) [y/N]`,
      );
    }
    setMessage(`Deleting ${name}...`);
    const ok = await deleteOne(id, name);
    const results: string[] = [];
    if (ok) results.push(name);
    if (alsoDelete) {
      for (const t of deletable) {
        const tid = idOf(t.sid)!;
        setMessage(`Deleting ${t.name}...`);
        if (t.raw?.pid != null) await stopSession(tid);
        if (await deleteOne(tid, t.name)) results.push(t.name);
      }
    }
    const prevMsg = S.message;
    await refresh();
    if (results.length && (!prevMsg || prevMsg.text.startsWith('Deleting') || prevMsg.text.startsWith('Waiting for')))
      setMessage(`Deleted ${results.join(', ')}.`);
  } finally {
    S.busy = false;
    rerender();
  }
}

// id for every sid seen in the last --json (including hidden rows), for cascade deletes.
const allRawIds = new Map<string, string>();

function openExternal(url: string, what: string) {
  void run('open', [url], { timeoutMs: 15000 }).then((r) => {
    if (r.code === 0) setMessage(`Opened ${what}.`);
    else setMessage(`open failed: ${(r.stderr || r.stdout || r.error || '').trim()}`, 'red');
  });
}

function externalItems(row: Row) {
  const w = S.where.get(row.cwd);
  const items: { label: string; act: () => void }[] = [];
  const pr = w?.pr;
  if (pr) items.push({ label: `Pull request #${pr.number} on GitHub`, act: () => openExternal(pr.url, `#${pr.number} on GitHub`) });
  const dir = w?.checkoutRoot ?? row.cwd;
  items.push({ label: `VS Code (${dir})`, act: () => openExternal(`vscode://file${dir}/`, `${dir} in VS Code`) });
  const gh = pr?.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (pr && gh) {
    const url = `https://vscode.dev/github/${gh[1]}/${gh[2]}/pull/${gh[3]}`;
    items.push({ label: `Pull request #${pr.number} on vscode.dev`, act: () => openExternal(url, `#${pr.number} on vscode.dev`) });
  }
  return { items, hasPR: !!pr };
}

async function dirCandidates(first?: string): Promise<string[]> {
  const out: string[] = [];
  const add = (p: string | undefined) => {
    if (p && !out.includes(p)) out.push(p);
  };
  add(first);
  add(process.cwd());
  for (const s of S.rawSessions) {
    if (!s.cwd) continue;
    add(S.where.get(s.cwd)?.repoRoot ?? (await gitInfo(s.cwd)).repoRoot ?? s.cwd);
  }
  for (const d of S.ghqDirs ?? []) add(d);
  return out;
}

async function loadGhq() {
  const r = await run('ghq', ['list', '-p'], { timeoutMs: 10000 });
  S.ghqDirs = r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  if (S.mode.kind === 'new' && S.mode.step === 'dir') {
    for (const d of S.ghqDirs) if (!S.mode.dirs.includes(d)) S.mode.dirs.push(d);
    rerender();
  }
}

async function openNew(waiter?: string) {
  let first: string | undefined;
  if (waiter) {
    const w = S.rows.find((r) => r.sid === waiter);
    if (w) first = S.where.get(w.cwd)?.repoRoot ?? (await gitInfo(w.cwd)).repoRoot ?? w.cwd;
  }
  S.mode = { kind: 'new', step: 'dir', query: '', index: 0, dirs: await dirCandidates(first), modelIndex: 0, model: '', waiter };
  rerender();
  if (!S.ghqDirs) void loadGhq();
}

function filteredDirs(m: Extract<Mode, { kind: 'new' }>) {
  const names = displayNames(m.dirs);
  return filterItems(m.dirs, m.query, (d) => names.get(d) ?? d, (d) => d);
}

async function launch(suspend: Suspend, m: Extract<Mode, { kind: 'new' }>) {
  m.step = 'launching';
  m.startedAt = Date.now();
  S.busy = true;
  const tick = setInterval(rerender, 1000);
  rerender();
  const res = await launchBg(m.dir!, m.model || undefined);
  clearInterval(tick);
  if (!res.id) {
    m.step = 'failed';
    m.output = res.output || `claude --bg exited with code ${res.code}`;
    S.busy = false;
    rerender();
    return;
  }
  if (m.waiter) S.pendingWait = { waiter: m.waiter, id: res.id };
  S.mode = { kind: 'list' };
  const startedAt = Date.now();
  await suspend(async () => {
    await runInTerminal(['attach', res.id!]);
  });
  S.busy = false;
  S.lastAttachedId = res.id;
  S.lastAttached = undefined;
  await afterAttach(undefined, undefined, startedAt);
}

function waitCandidates(m: Extract<Mode, { kind: 'wait' }>) {
  const targets = S.waits.get(m.sid) ?? new Set<string>();
  const cands = S.rows.filter((r) => r.sid !== m.sid && (targets.has(r.sid) || !wouldCycle(S.waits, m.sid, r.sid)));
  const sorted = flatOrder(group(cands, S.lastAttached, S.holds));
  return filterItems(sorted, m.query, (r) => r.name, (r) => r.cwd);
}

function toggleWait(waiter: string, target: string) {
  const set = S.waits.get(waiter) ?? new Set<string>();
  if (set.has(target)) {
    set.delete(target);
    setMessage(`${nameOf(waiter)} no longer waits for ${nameOf(target)}.`);
  } else {
    if (wouldCycle(S.waits, waiter, target)) return;
    set.add(target);
    setMessage(`${nameOf(waiter)} now waits for ${nameOf(target)}.`);
  }
  if (set.size) S.waits.set(waiter, set);
  else {
    S.waits.delete(waiter);
    S.doneNotes.delete(waiter);
  }
  recompute(Date.now());
}

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------- key handling ----------------

function moveSelection(delta: number) {
  const order = flatOrder(groups());
  if (!order.length) return;
  const i = order.findIndex((r) => r.sid === S.selected);
  const j = Math.max(0, Math.min(order.length - 1, (i < 0 ? 0 : i) + delta));
  S.selected = order[j].sid;
}

function textEdit(cur: string, input: string, key: { backspace?: boolean; delete?: boolean }) {
  if (key.backspace || key.delete) return cur.slice(0, -1);
  const clean = input.replace(/[\r\n]/g, '');
  if (!clean || /[\x00-\x1f]/.test(clean)) return cur;
  return cur + clean;
}

function handleKey(input: string, key: any, exit: () => void, suspend: Suspend) {
  const m = S.mode;
  if (m.kind === 'confirm') {
    S.mode = { kind: 'list' };
    m.resolve(input.toLowerCase() === 'y');
    rerender();
    return;
  }
  if (m.kind === 'new' && m.step === 'launching') return;
  if (S.busy && m.kind !== 'new') return;

  if (m.kind === 'hold') {
    if (key.escape) S.mode = { kind: 'list' };
    else if (key.return) {
      const order = flatOrder(groups());
      const i = order.findIndex((r) => r.sid === m.sid);
      S.holds.set(m.sid, m.text.trim());
      const next = order.slice(i + 1).find((r) => !S.holds.has(r.sid)) ?? order.slice(0, i).reverse().find((r) => !S.holds.has(r.sid));
      S.selected = next?.sid ?? m.sid;
      S.mode = { kind: 'list' };
      S.message = { text: `Put ${nameOf(m.sid)} on hold. It comes back when you attach and work on it, or press h on it.` };
    } else m.text = textEdit(m.text, input, key);
    rerender();
    return;
  }

  if (m.kind === 'external') {
    const row = S.rows.find((r) => r.sid === m.sid);
    if (!row || key.escape) S.mode = { kind: 'list' };
    else {
      const { items } = externalItems(row);
      if (key.upArrow) m.index = Math.max(0, m.index - 1);
      else if (key.downArrow) m.index = Math.min(items.length - 1, m.index + 1);
      else if (key.return || /^[1-9]$/.test(input)) {
        const idx = key.return ? m.index : Number(input) - 1;
        if (items[idx]) {
          S.mode = { kind: 'list' };
          items[idx].act();
        }
      }
    }
    rerender();
    return;
  }

  if (m.kind === 'wait') {
    const cands = waitCandidates(m);
    const total = cands.length + 1; // + New session
    if (key.escape) S.mode = { kind: 'list' };
    else if (key.upArrow) m.index = Math.max(0, m.index - 1);
    else if (key.downArrow) m.index = Math.min(total - 1, m.index + 1);
    else if (key.return) {
      if (m.index === 0) void openNew(m.sid);
      else {
        const t = cands[m.index - 1];
        S.mode = { kind: 'list' };
        if (t) toggleWait(m.sid, t.sid);
      }
    } else {
      const q = textEdit(m.query, input, key);
      if (q !== m.query) {
        m.query = q;
        m.index = q ? 1 : 0;
        if (waitCandidates(m).length === 0) m.index = 0;
      }
    }
    rerender();
    return;
  }

  if (m.kind === 'new') {
    if (m.step === 'failed') {
      S.mode = { kind: 'list' };
      void refresh();
      return;
    }
    if (m.step === 'dir') {
      const list = filteredDirs(m);
      const total = list.length + 1; // + Other...
      if (key.escape) S.mode = { kind: 'list' };
      else if (key.upArrow) m.index = Math.max(0, m.index - 1);
      else if (key.downArrow) m.index = Math.min(total - 1, m.index + 1);
      else if (key.return) {
        if (m.index < list.length) {
          m.dir = list[m.index];
          m.step = 'model';
        } else m.step = 'dirOther';
      } else {
        const q = textEdit(m.query, input, key);
        if (q !== m.query) {
          m.query = q;
          m.index = 0;
        }
      }
    } else if (m.step === 'dirOther') {
      if (key.escape) m.step = 'dir';
      else if (key.return) {
        const v = m.query.trim().replace(/^~(?=$|\/)/, os.homedir());
        const dir = v ? path.resolve(v) : process.cwd();
        if (isDir(dir)) {
          m.dir = dir;
          m.dirError = undefined;
          m.step = 'model';
        } else m.dirError = `Not a directory: ${dir}`;
      } else {
        m.query = textEdit(m.query, input, key);
        m.dirError = undefined;
      }
    } else if (m.step === 'model') {
      if (key.escape) m.step = 'dir';
      else if (key.upArrow) m.modelIndex = 0;
      else if (key.downArrow) m.modelIndex = 1;
      else if (key.return) {
        if (m.modelIndex === 0) {
          m.model = '';
          void launch(suspend, m);
        } else m.step = 'modelOther';
      }
    } else if (m.step === 'modelOther') {
      if (key.escape) {
        m.step = 'model';
        m.model = '';
      } else if (key.return) {
        if (m.model.trim()) {
          m.model = m.model.trim();
          void launch(suspend, m);
        }
      } else m.model = textEdit(m.model, input, key);
    }
    rerender();
    return;
  }

  // ---- list mode ----
  const pd = S.pendingDelete;
  const isCtrlX = key.ctrl && input === 'x';
  if (pd && !isCtrlX) {
    S.pendingDelete = undefined;
    if (key.escape) {
      setMessage('Delete cancelled.');
      void refresh();
      return;
    }
  }
  S.message = undefined;
  const row = selectedRow();

  if (key.upArrow || input === 'k') moveSelection(-1);
  else if (key.downArrow || input === 'j') moveSelection(1);
  else if (input === 'q' || (key.ctrl && input === 'c')) exit();
  else if (input === 'r') {
    void refresh({ manual: true });
    void refreshUsage();
  } else if (key.return && row) {
    if (row.kind === 'background' && row.id) void attach(suspend, { sid: row.sid, id: row.id });
    else setMessage(`${row.name} is an interactive session (not attachable). cwd: ${row.cwd}  pid: ${row.pid ?? '-'}`);
  } else if (input === 'n') void openNew();
  else if (input === 'h' && row) {
    if (S.holds.has(row.sid)) {
      S.holds.delete(row.sid);
      setMessage(`${row.name} is back in the list.`);
    } else S.mode = { kind: 'hold', sid: row.sid, text: '' };
  } else if (input === 'e' && row) S.mode = { kind: 'external', sid: row.sid, index: 0 };
  else if (input === 'w' && row) S.mode = { kind: 'wait', sid: row.sid, query: '', index: 0 };
  else if (isCtrlX && row) {
    if (pd && pd.sid === row.sid && (pd.stopping || Date.now() - pd.at <= 2000)) {
      S.pendingDelete = undefined;
      void deleteWithCascade(pd.sid, pd.id, pd.name);
    } else if (row.kind !== 'background' || !row.id) {
      setMessage(`${row.name} is an interactive session; stop it from its own terminal.`);
    } else {
      const p = { sid: row.sid, id: row.id, name: row.name, at: Date.now(), stopping: true };
      S.pendingDelete = p;
      setMessage(`Stopping ${row.name}... (Ctrl+X again to delete)`);
      void stopSession(row.id).then((r) => {
        p.stopping = false;
        if (S.pendingDelete === p) {
          setMessage(r.code === 0 ? `Stopped ${row.name}. Ctrl+X again to delete.` : `Stop failed: ${(r.stderr || r.stdout).trim()} (Ctrl+X again to delete)`);
          const left = Math.max(0, 2000 - (Date.now() - p.at));
          setTimeout(() => {
            if (S.pendingDelete === p) {
              S.pendingDelete = undefined;
              void refresh();
            }
          }, left);
        }
      });
    }
  }
  rerender();
}

// ---------------- rendering ----------------

const TIER_COLOR: Record<Tier, string> = {
  Permission: 'red',
  Question: 'yellow',
  Sandbox: 'yellow',
  Failed: 'magenta',
  Review: 'cyan',
  Working: 'green',
  Waiting: 'gray',
};
const PR_COLOR = { open: 'green', draft: 'gray', merged: 'magenta', closed: 'red' } as const;

function fmtCtx(n?: number) {
  if (n == null) return '';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
function fmtCost(n?: number) {
  return n == null ? '' : `$${n.toFixed(2)}`;
}

function UsageLine() {
  if (!S.usage) return null;
  return (
    <Text>
      {S.usage.map((u, i) => (
        <Text key={u.label}>
          {i > 0 ? ' · ' : ''}
          {u.label} <Text color={u.percent >= 80 ? 'red' : u.percent >= 50 ? 'yellow' : undefined}>{u.percent}%</Text>
          {u.resets ? ` (resets ${u.resets})` : ''}
        </Text>
      ))}
    </Text>
  );
}

function WhereCell({ row }: { row: Row }) {
  const w = S.where.get(row.cwd);
  if (!w) return <Text wrap="truncate">{path.basename(row.cwd)}</Text>;
  return (
    <Text wrap="truncate">
      {w.repo}
      {w.branch ? ` ${w.branch}` : ''}
      {w.worktree ? ' (wt)' : ''}
      {w.pr ? (
        <Text color={PR_COLOR[w.pr.state]}>
          {' '}#{w.pr.number} ({w.pr.state})
        </Text>
      ) : (
        ''
      )}
    </Text>
  );
}

type Cols = { tier: number; wait: number; name: number; ctx: number; cost: number };

function rowLines(row: Row, cols: Cols, now: number): React.ReactNode[] {
  const sel = row.sid === S.selected;
  const o = otelFor(row.sid);
  const notes: string[] = [];
  if (row.tier === 'Waiting') {
    const all = [...(S.waits.get(row.sid) ?? [])];
    const tiers = new Map(S.rows.map((r) => [r.sid, r.tier]));
    const open = unfinishedTargets(row.sid, S.waits, tiers).map((t) => nameOf(t) + (S.holds.has(t) ? ' (on hold)' : ''));
    notes.push(all.length === 1 ? `↳ for ${open.join(', ')}` : `↳ for ${open.length} of ${all.length}: ${open.join(', ')}`);
  }
  const done = S.doneNotes.get(row.sid);
  if (done && row.tier !== 'Waiting') notes.push(`↳ ${done.join(', ')} done`);
  const reason = S.holds.get(row.sid);
  if (reason) notes.push(`↳ ${reason}`);
  return [
    <Box key={row.sid}>
      <Box width={2} flexShrink={0}>
        <Text color={sel ? 'cyan' : undefined} bold={sel}>
          {sel ? '> ' : '  '}
        </Text>
      </Box>
      <Box width={cols.tier} marginRight={1} flexShrink={0}>
        <Text color={TIER_COLOR[row.tier]} wrap="truncate">
          {tierLabel(row)}
        </Text>
      </Box>
      <Box width={cols.wait} marginRight={2} flexShrink={0} justifyContent="flex-end">
        <Text>{formatWaiting(row.since, now)}</Text>
      </Box>
      <Box width={cols.name} marginRight={2} flexShrink={0}>
        <Text bold={sel} wrap="truncate">
          {row.name}
          {row.kind === 'interactive' ? ' (tty)' : ''}
        </Text>
      </Box>
      {cols.ctx > 0 && (
        <Box width={cols.ctx} marginRight={2} flexShrink={0} justifyContent="flex-end">
          <Text>{fmtCtx(o?.ctx)}</Text>
        </Box>
      )}
      {cols.cost > 0 && (
        <Box width={cols.cost} marginRight={2} flexShrink={0} justifyContent="flex-end">
          <Text>{fmtCost(o?.cost)}</Text>
        </Box>
      )}
      <Box flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
        <WhereCell row={row} />
      </Box>
    </Box>,
    ...notes.map((n, i) => (
      <Box key={`${row.sid}-n${i}`} paddingLeft={4 + cols.tier + cols.wait + 2}>
        <Text dimColor wrap="truncate">
          {n}
        </Text>
      </Box>
    )),
  ];
}

function Heading({ text }: { text: string }) {
  return (
    <Text bold dimColor>
      {'  '}
      {text}
    </Text>
  );
}

type Line = { key: string; node: React.ReactNode; sid?: string };

function ListView({ width, maxLines }: { width: number; maxLines: number }) {
  const now = Date.now();
  if (S.error)
    return (
      <Text color="red" wrap="wrap">
        Could not read sessions: {S.error}
      </Text>
    );
  if (!S.loaded) return <Text dimColor>Loading sessions...</Text>;
  if (!S.rows.length) return <Text>No sessions need attention. Press n to start one.</Text>;
  const g = groups();
  const rowsAll = S.rows;
  const hasCtx = rowsAll.some((r) => otelFor(r.sid)?.ctx != null);
  const hasCost = rowsAll.some((r) => otelFor(r.sid)?.cost != null);
  const cols: Cols = {
    tier: Math.max(4, ...rowsAll.map((r) => tierLabel(r).length)),
    wait: 7,
    name: Math.min(Math.max(7, ...rowsAll.map((r) => r.name.length + (r.kind === 'interactive' ? 6 : 0))), Math.max(12, Math.floor(width * 0.3))),
    ctx: hasCtx ? 5 : 0,
    cost: hasCost ? 7 : 0,
  };
  const showUpNext = !!g.last || g.hold.length > 0;
  const rowToLines = (r: Row): Line[] => rowLines(r, cols, now).map((node, i) => ({ key: `${r.sid}-${i}`, node, sid: i === 0 ? r.sid : undefined }));
  // Fixed: Last attached group and the Up next heading. Scrolls: ladder and hold.
  const fixed: Line[] = [];
  if (g.last) {
    fixed.push({ key: 'h-last', node: <Heading text="Last attached" /> }, ...rowToLines(g.last), { key: 'b-last', node: <Text> </Text> });
  }
  if (showUpNext && g.ladder.length > 0) fixed.push({ key: 'h-next', node: <Heading text="Up next" /> });
  const body: Line[] = g.ladder.flatMap(rowToLines);
  if (g.hold.length > 0) {
    body.push({ key: 'b-hold', node: <Text> </Text> }, { key: 'h-hold', node: <Heading text="On hold" /> }, ...g.hold.flatMap(rowToLines));
  }
  let shown = body;
  let position: string | undefined;
  const room = maxLines - 1 - fixed.length; // - column header
  if (body.length > room) {
    const win = Math.max(1, room - 1); // - position line
    const selIdx = Math.max(0, body.findIndex((l) => l.sid === S.selected));
    const start = Math.max(0, Math.min(selIdx - Math.floor(win / 2), body.length - win));
    shown = body.slice(start, start + win);
    const order = flatOrder(g);
    const i = order.findIndex((r) => r.sid === S.selected);
    position = `  ${i + 1}/${order.length}`;
  }
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>
          {'  '}
          {'TIER'.padEnd(cols.tier + 1)}
          {'WAITING'.padStart(cols.wait)}
          {'  '}
          {'SESSION'.padEnd(cols.name + 2)}
          {cols.ctx ? 'CTX'.padStart(cols.ctx) + '  ' : ''}
          {cols.cost ? 'COST'.padStart(cols.cost) + '  ' : ''}
          WHERE
        </Text>
      </Box>
      {[...fixed, ...shown].map((l) => (
        <React.Fragment key={l.key}>{l.node}</React.Fragment>
      ))}
      {position && <Text dimColor>{position}</Text>}
    </Box>
  );
}

function Picker({ items, index, max = 10 }: { items: string[]; index: number; max?: number }) {
  const start = Math.max(0, Math.min(index - Math.floor(max / 2), items.length - max));
  return (
    <Box flexDirection="column">
      {items.slice(start, start + max).map((it, i) => {
        const sel = start + i === index;
        return (
          <Text key={start + i} color={sel ? 'cyan' : undefined} wrap="truncate">
            {sel ? '> ' : '  '}
            {it}
          </Text>
        );
      })}
    </Box>
  );
}

function ModeView() {
  const m = S.mode;
  if (m.kind === 'hold')
    return (
      <Text>
        Put {nameOf(m.sid)} on hold. Reason (optional): {m.text}
        <Text inverse> </Text>
        <Text dimColor> (Enter to hold, Esc to cancel)</Text>
      </Text>
    );
  if (m.kind === 'confirm') return <Text color="yellow">{m.text}</Text>;
  if (m.kind === 'external') {
    const row = S.rows.find((r) => r.sid === m.sid);
    if (!row) return null;
    const { items, hasPR } = externalItems(row);
    return (
      <Box flexDirection="column">
        <Text bold>Show {row.name} in:</Text>
        <Picker items={items.map((it, i) => `${i + 1}. ${it.label}`)} index={m.index} />
        {!hasPR && <Text dimColor>  No pull request for this session.</Text>}
        <Text dimColor>  ↑↓/number select · Enter open · Esc close</Text>
      </Box>
    );
  }
  if (m.kind === 'wait') {
    const cands = waitCandidates(m);
    const targets = S.waits.get(m.sid) ?? new Set();
    const items = ['New session', ...cands.map((r) => `${targets.has(r.sid) ? '[x]' : '[ ]'} ${r.name}  (${r.tier})`)];
    return (
      <Box flexDirection="column">
        <Text bold>
          {nameOf(m.sid)} waits for: <Text>{m.query}</Text>
          <Text inverse> </Text>
        </Text>
        <Picker items={items} index={m.index} />
        <Text dimColor>  Type to filter · Enter add/remove · Esc close</Text>
      </Box>
    );
  }
  if (m.kind === 'new') {
    const title = m.waiter ? `New session for ${nameOf(m.waiter)} to wait for` : 'New session';
    if (m.step === 'dir') {
      const list = filteredDirs(m);
      const names = displayNames(m.dirs);
      return (
        <Box flexDirection="column">
          <Text bold>
            {title} — working directory: {m.query}
            <Text inverse> </Text>
          </Text>
          <Picker items={[...list.map((d) => names.get(d) ?? d), 'Other...']} index={m.index} />
          <Text dimColor>  Type to filter · Enter select · Esc cancel</Text>
        </Box>
      );
    }
    if (m.step === 'dirOther')
      return (
        <Box flexDirection="column">
          <Text bold>
            {title} — working directory path: {m.query}
            <Text inverse> </Text>
          </Text>
          {m.dirError && <Text color="red">  {m.dirError}</Text>}
          <Text dimColor>  Enter confirm (empty: {process.cwd()}) · Esc back</Text>
        </Box>
      );
    if (m.step === 'model')
      return (
        <Box flexDirection="column">
          <Text bold>
            {title} in {m.dir} — model:
          </Text>
          <Picker items={['default', 'Other...']} index={m.modelIndex} />
          <Text dimColor>  Enter select · Esc back</Text>
        </Box>
      );
    if (m.step === 'modelOther')
      return (
        <Box flexDirection="column">
          <Text bold>
            {title} in {m.dir} — model name: {m.model}
            <Text inverse> </Text>
          </Text>
          <Text dimColor>  Enter start · Esc back</Text>
        </Box>
      );
    if (m.step === 'launching')
      return (
        <Box flexDirection="column">
          <Text bold>{title}</Text>
          <Text>  Directory: {m.dir}</Text>
          <Text>  Model: {m.model || 'default'}</Text>
          <Text color="yellow">
            {'  '}Starting... {Math.floor((Date.now() - (m.startedAt ?? Date.now())) / 1000)}s
          </Text>
        </Box>
      );
    if (m.step === 'failed')
      return (
        <Box flexDirection="column">
          <Text bold color="red">
            Could not start the session in {m.dir}:
          </Text>
          <Text>{m.output}</Text>
          <Text dimColor>Press any key to return to the list.</Text>
        </Box>
      );
  }
  return null;
}

const HELP = '↑↓ select · Enter attach · n new · w wait for · h hold · e show in · ^X stop/delete · r refresh · q quit';

function linesOf(text: string | undefined, columns: number) {
  if (!text) return 0;
  return text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(1, columns))), 0);
}

/** Lines the panel under the list takes, so the list leaves room for it. */
function modeLines(columns: number) {
  const m = S.mode;
  if (m.kind === 'hold' || m.kind === 'confirm') return 1;
  if (m.kind === 'external') {
    const row = S.rows.find((r) => r.sid === m.sid);
    if (!row) return 0;
    const { items, hasPR } = externalItems(row);
    return 2 + Math.min(items.length, 10) + (hasPR ? 0 : 1);
  }
  if (m.kind === 'wait') return 2 + Math.min(waitCandidates(m).length + 1, 10);
  return 0;
}

export function App() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  rerender = force;

  useEffect(() => {
    void refresh();
    void refreshUsage();
    const t = setInterval(() => {
      if (!S.busy && !S.refreshing && S.lastRefreshAt && Date.now() - S.lastRefreshAt >= 60000) void refresh();
      else rerender();
    }, 5000);
    return () => clearInterval(t);
  }, []);

  useInput((input, key) => handleKey(input, key, exit, suspendTerminal as Suspend));

  const fullScreenNew = S.mode.kind === 'new';
  const status = S.refreshing ? 'refreshing...' : S.flash;
  const maxLines = (rows || 24) - 2 - 1 - linesOf(S.message?.text, columns) - modeLines(columns) - (S.mode.kind === 'list' ? linesOf(HELP, columns) : 0);
  return (
    <Box flexDirection="column" width={columns}>
      <Box>
        <Text bold>whatnext</Text>
        <Text>{'  '}</Text>
        <UsageLine />
      </Box>
      <Text> </Text>
      {fullScreenNew ? (
        <ModeView />
      ) : (
        <>
          <ListView width={columns} maxLines={maxLines} />
          <Text dimColor>{status ?? ' '}</Text>
          {S.message && (
            <Text color={S.message.color} wrap="wrap">
              {S.message.text}
            </Text>
          )}
          <ModeView />
          {S.mode.kind === 'list' && (
            <Text dimColor>
              {HELP}
            </Text>
          )}
        </>
      )}
    </Box>
  );
}

// exported for the cascade: keep ids of every row seen (visible or not)
export function rememberIds(rows: RawRow[]) {
  for (const r of rows) if (r.sessionId && r.id) allRawIds.set(r.sessionId, r.id);
}
