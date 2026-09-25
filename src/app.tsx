import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { launch, listAgents, rm, run, stop } from './agents.js';
import { Candidate, candidates, filter } from './launch.js';
import { formatCost, formatTokens, OtelStore, startReceiver } from './otel.js';
import { fetchUsage, Limit } from './usage.js';
import { activityKey, Entry, formatWait, observe, Seen, splitGroups, tierLabel } from './rank.js';
import { Git, gitInfo, OpenTarget, openTargets, Pr, prFor, whereText } from './where.js';

const REFRESH_MS = 60_000;
const DELETE_WINDOW_MS = 2000;
// Undo anything a crashed child may have left: alt screen, mouse tracking, focus events,
// bracketed paste, hidden cursor, kitty keyboard / modifyOtherKeys.
const ALT_OFF = '\x1b[?1049l';
const TERM_RESET =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l\x1b[?25h\x1b[<u\x1b[>4;0m';

type Mode =
  | { kind: 'list' }
  | { kind: 'info'; entry: Entry }
  | { kind: 'pickDir'; items: Candidate[] | null; query: string; index: number }
  | { kind: 'otherDir'; text: string }
  | { kind: 'pickModel'; dir: string; index: number }
  | { kind: 'model'; dir: string; text: string }
  | { kind: 'starting'; dir: string; model: string; at: number; failed: string | null }
  | { kind: 'discard'; id: string; value: string; count: number }
  | { kind: 'external'; entry: Entry; index: number };

type Where = { git?: Git | null; pr?: Pr | null };

const PR_COLOR: Record<Pr['state'], string> = { open: 'green', draft: 'gray', merged: 'magenta', closed: 'red' };
const TIER_COLOR: Record<string, string> = {
  Permission: 'red', Question: 'yellow', Sandbox: 'yellow', Failed: 'magenta', Review: 'cyan', Working: 'gray',
};

function waitKey(): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', () => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      resolve();
    });
  });
}

// Hand the terminal to a child and wait for it to exit.
function runChild(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: 'inherit' });
    c.on('error', (e) => { process.stderr.write(`${e.message}\n`); resolve(-1); });
    c.on('exit', (code) => resolve(code ?? -1));
  });
}

const clean = (s: string) => s.replace(/[\r\n]/g, '');

export function App({ startDir }: { startDir: string }) {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [where, setWhere] = useState<Map<string, Where>>(new Map());
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [message, setMessage] = useState<string | null>(null);
  const [usage, setUsage] = useState<Limit[]>([]);
  // Agent id of the session last left by attach, shown above the ladder until the next attach.
  const [lastId, setLastId] = useState<string | null>(null);
  const lastIdRef = useRef<string | null>(null);
  // sessionIds the user put on hold, shown below the ladder. Only in memory (ADR-0002).
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const heldRef = useRef<ReadonlySet<string>>(new Set());
  const entriesRef = useRef<Entry[]>([]);
  const seenRef = useRef<Seen>(new Map());
  const prevRef = useRef<number | null>(null);
  const busyRef = useRef(false); // attached or refreshing
  // The external menu's selection, read synchronously: ↓ and Enter can arrive before a re-render.
  const openIndexRef = useRef(0);
  const pendingRef = useRef<{ id: string; at: number; stopping: boolean } | null>(null);
  const otelRef = useRef(new OtelStore());

  const loadWhere = useCallback((es: Entry[]) => {
    const cwds = [...new Set(es.map((e) => e.row.cwd))];
    for (const cwd of cwds) {
      void (async () => {
        const git = await gitInfo(cwd);
        setWhere((m) => new Map(m).set(cwd, { ...m.get(cwd), git }));
        const pr = git?.branch ? await prFor(cwd, git.branch) : null;
        setWhere((m) => new Map(m).set(cwd, { git, pr }));
      })();
    }
  }, []);

  const updateHeld = useCallback((f: (s: Set<string>) => void) => {
    const next = new Set(heldRef.current);
    f(next);
    heldRef.current = next;
    setHeld(next);
  }, []);

  // Returns the new entries so callers can act on them without waiting for a render.
  const refresh = useCallback(async (opts: { afterAttach?: boolean } = {}): Promise<Entry[] | null> => {
    const t = Date.now();
    setRefreshing(true);
    try {
      const rows = await listAgents();
      const { entries: es, seen } = observe(rows, seenRef.current, prevRef.current, otelRef.current.lastEvent);
      seenRef.current = seen;
      prevRef.current = t;
      entriesRef.current = es;
      setEntries(es);
      setError(null);
      setCursorId((cur) => {
        const { rest } = splitGroups(es, lastIdRef.current, heldRef.current);
        // The session just left is selected whether it is in the last-attached group or on hold.
        const left = opts.afterAttach ? es.find((e) => e.row.id === lastIdRef.current) : undefined;
        if (left) return left.row.sessionId;
        if (!opts.afterAttach && cur && es.some((e) => e.row.sessionId === cur)) return cur;
        return rest[0]?.row.sessionId ?? null;
      });
      loadWhere(es);
      setRefreshing(false);
      setLastRefresh(t);
      setLoaded(true);
      return es;
    } catch (e) {
      entriesRef.current = [];
      setEntries([]);
      setError(e instanceof Error ? e.message : String(e));
    }
    setRefreshing(false);
    setLastRefresh(t);
    setLoaded(true);
    return null;
  }, [loadWhere]);

  // Not on the 60s timer: only at start, after attach and on `r`. Keeps the old value while fetching.
  const loadUsage = useCallback(() => { void fetchUsage().then(setUsage); }, []);

  useEffect(() => { void refresh(); loadUsage(); }, [refresh, loadUsage]);
  useEffect(() => {
    const p = startReceiver(otelRef.current, () => {});
    return () => { void p.then((s) => s?.close()); };
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (lastRefresh === null) return;
    const t = setTimeout(() => { if (!busyRef.current) void refresh(); }, Math.max(0, lastRefresh + REFRESH_MS - Date.now()));
    return () => clearTimeout(t);
  }, [lastRefresh, refresh]);

  const { last, rest, held: onHold } = splitGroups(entries, lastId, held);
  const list = [...(last ? [last] : []), ...rest, ...onHold];
  const cursor = Math.max(0, list.findIndex((e) => e.row.sessionId === cursorId));
  const current = list[cursor];

  const attach = useCallback(async (id: string) => {
    busyRef.current = true;
    setMessage(null);
    // A held session stays on hold if the attach was only a look: nothing about it changed.
    const before = entriesRef.current.find((e) => e.row.id === id);
    const snap = before && heldRef.current.has(before.row.sessionId)
      ? { sid: before.row.sessionId, key: activityKey(before.row), ev: otelRef.current.lastEvent.get(before.row.sessionId) ?? 0 }
      : null;
    await suspendTerminal(async () => {
      const ignore = () => {};
      const sigs = ['SIGINT', 'SIGTSTP', 'SIGQUIT'] as const;
      for (const s of sigs) process.on(s, ignore);
      try {
        // Save the tty settings while they are sane and put them back after the child, even if it
        // crashed while raw (libuv's setRawMode(false) cannot do this, see #33).
        const saved = spawnSync('stty', ['-g'], { stdio: ['inherit', 'pipe', 'ignore'] }).stdout?.toString().trim();
        // Ink's pauseInput leaves its 'readable' listener attached, so Node keeps a read pending on the
        // tty and steals the child's first keystroke (a first Ctrl+Z was ignored). Stop reading while
        // the child runs and restart it afterwards. Uses Node internals; see the decision-log issue.
        const stdinAny = process.stdin as unknown as {
          _handle?: { reading?: boolean; readStop?: () => void };
          _readableState?: { reading?: boolean };
        };
        // attach() starts inside Ink's 'readable' handler, whose read() loop would restart the read
        // right after we stop it; let that handler finish first.
        await new Promise((r) => setImmediate(r));
        // Any 'readable' listener calling read() would restart the read, so detach them too.
        const readables = process.stdin.listeners('readable') as ((...a: unknown[]) => void)[];
        process.stdin.removeAllListeners('readable');
        if (stdinAny._handle?.readStop) { stdinAny._handle.reading = false; stdinAny._handle.readStop(); }
        const code = await runChild('claude', ['attach', id]);
        if (stdinAny._readableState) stdinAny._readableState.reading = false;
        process.stdout.write(TERM_RESET);
        if (saved) spawnSync('stty', [saved], { stdio: ['inherit', 'ignore', 'ignore'] });
        // On failure, keep the child's message on screen (even if it is on the alternate screen).
        if (code !== 0) {
          process.stdout.write(`\r\n[whatnext] claude attach exited with code ${code}. Press any key to return to the list.`);
          await waitKey();
        }
        process.stdout.write(ALT_OFF);
        for (const l of readables) process.stdin.on('readable', l);
        process.stdin.read(0);
      } finally {
        for (const s of sigs) process.off(s, ignore);
      }
    });
    busyRef.current = false;
    loadUsage();
    lastIdRef.current = id;
    setLastId(id);
    const es = await refresh({ afterAttach: true });
    if (!snap || !es) return;
    const after = es.find((e) => e.row.sessionId === snap.sid);
    const touched = !after || activityKey(after.row) !== snap.key
      || (otelRef.current.lastEvent.get(snap.sid) ?? 0) > snap.ev;
    if (touched) updateHeld((h) => h.delete(snap.sid));
  }, [suspendTerminal, refresh, loadUsage, updateHeld]);

  const removeEntry = (id: string) => {
    setEntries((es) => es.filter((e) => e.row.id !== id));
    setCursorId((cur) => {
      const gone = list.find((e) => e.row.id === id)?.row.sessionId;
      if (cur !== gone) return cur;
      return list.find((e) => e.row.id !== id)?.row.sessionId ?? null;
    });
  };

  const doDelete = async (id: string, discard?: string) => {
    setMessage(`Deleting ${id}...`);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const r = await rm(id, discard);
      const out = `${r.stdout}${r.stderr}`.trim();
      if (r.code === 0) {
        removeEntry(id);
        setMessage(`Deleted ${id}.`);
        return;
      }
      const d = !discard && out.match(/--discard-unpushed\s+(\S+)/);
      if (d) {
        const n = Number(out.match(/(\d+)\s+unpushed commit/)?.[1] ?? 1);
        setMessage(null);
        setMode({ kind: 'discard', id, value: d[1], count: n });
        return;
      }
      // The stopped process may not have exited yet; `claude rm` then keeps the worktree (lock).
      if (/^kept\b/m.test(out) && !/unpushed|uncommitted/i.test(out) && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }
      setMessage(out || `claude rm exited with ${r.code}`);
      return;
    }
  };

  const ctrlX = (e: Entry) => {
    const id = e.row.id;
    if (e.row.kind !== 'background' || !id) {
      setMessage('Interactive sessions cannot be stopped from whatnext.');
      return;
    }
    const p = pendingRef.current;
    if (p && p.id === id && (p.stopping || Date.now() - p.at <= DELETE_WINDOW_MS)) {
      pendingRef.current = null;
      void doDelete(id);
      return;
    }
    const pending = { id, at: Date.now(), stopping: true };
    pendingRef.current = pending;
    setMessage(`Stopping ${e.row.name ?? id}... press Ctrl+X again within 2s to delete.`);
    void stop(id).then((r) => {
      pending.stopping = false;
      if (pendingRef.current !== pending) return;
      const out = `${r.stdout}${r.stderr}`.trim();
      setMessage(r.code === 0
        ? `Stopped ${e.row.name ?? id}. Press Ctrl+X again within 2s to delete.`
        : `${out || 'claude stop failed'}. Press Ctrl+X again within 2s to delete.`);
      const left = Math.max(0, pending.at + DELETE_WINDOW_MS - Date.now());
      setTimeout(() => {
        if (pendingRef.current === pending) { pendingRef.current = null; setMessage(null); }
      }, left);
    });
  };

  const startNew = async (dir: string, model: string) => {
    // Stay on the new-session screen until attach: going back to the list reads as done or cancelled.
    const starting = { kind: 'starting', dir, model, at: Date.now(), failed: null } as const;
    setMode(starting);
    const r = await launch(dir, model);
    if (!r.id) {
      setMode({ ...starting, failed: r.out || `claude --bg exited with ${r.code}` });
      return;
    }
    setMode({ kind: 'list' });
    await attach(r.id);
  };

  const openUrl = async (t: OpenTarget) => {
    const r = await run('open', [t.url]);
    setMessage(r.code === 0 ? `Opened ${t.label}.` : `${`${r.stderr}${r.stdout}`.trim() || `open exited with ${r.code}`}`);
  };

  const targetsFor = (e: Entry) => {
    const w = where.get(e.row.cwd);
    return openTargets(e.row.cwd, w?.git, w?.pr);
  };

  const openPicker = () => {
    setMode({ kind: 'pickDir', items: null, query: '', index: 0 });
    void candidates(startDir, entries.map((e) => e.row.cwd)).then((items) =>
      setMode((m) => (m.kind === 'pickDir' ? { ...m, items } : m)));
  };

  const resolveDir = (text: string) => {
    const t = text.trim();
    const expanded = t.startsWith('~') ? path.join(os.homedir(), t.slice(1)) : t;
    return path.resolve(startDir, expanded || '.');
  };

  const editText = (text: string, input: string, key: { backspace: boolean; delete: boolean }) => {
    if (key.backspace || key.delete) return text.slice(0, -1);
    return text + clean(input);
  };

  useInput((input, key) => {
    if (busyRef.current) return;
    switch (mode.kind) {
      case 'info':
        setMode({ kind: 'list' });
        return;
      case 'discard':
        setMode({ kind: 'list' });
        if (input.toLowerCase() === 'y') void doDelete(mode.id, mode.value);
        else setMessage('Delete cancelled.');
        return;
      case 'pickDir': {
        if (key.escape) { setMode({ kind: 'list' }); return; }
        const shown: (Candidate | null)[] = [...filter(mode.items ?? [], mode.query), null];
        if (key.upArrow) { setMode({ ...mode, index: Math.max(0, mode.index - 1) }); return; }
        if (key.downArrow) { setMode({ ...mode, index: Math.min(shown.length - 1, mode.index + 1) }); return; }
        if (key.return) {
          if (mode.items === null) return;
          const pick = shown[Math.min(mode.index, shown.length - 1)];
          if (pick === null) setMode({ kind: 'otherDir', text: mode.query });
          else setMode({ kind: 'pickModel', dir: pick.path, index: 0 });
          return;
        }
        if (key.ctrl || key.meta || key.tab) return;
        setMode({ ...mode, query: editText(mode.query, input, key), index: 0 });
        return;
      }
      case 'otherDir': {
        if (key.escape) { setMode({ kind: 'list' }); return; }
        if (key.return) {
          const dir = resolveDir(mode.text);
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { setMessage(`Not a directory: ${dir}`); return; }
          setMessage(null);
          setMode({ kind: 'pickModel', dir, index: 0 });
          return;
        }
        if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
        setMode({ ...mode, text: editText(mode.text, input, key) });
        return;
      }
      case 'pickModel': {
        // Only "default" or a typed name: no model list to keep up to date, and no typing by accident.
        if (key.escape) { setMode({ kind: 'list' }); return; }
        if (key.upArrow) { setMode({ ...mode, index: 0 }); return; }
        if (key.downArrow) { setMode({ ...mode, index: 1 }); return; }
        if (key.return) {
          if (mode.index === 0) void startNew(mode.dir, '');
          else setMode({ kind: 'model', dir: mode.dir, text: '' });
        }
        return;
      }
      case 'model': {
        if (key.escape) { setMode({ kind: 'pickModel', dir: mode.dir, index: 1 }); return; }
        if (key.return) {
          const model = mode.text.trim();
          if (model) void startNew(mode.dir, model);
          return;
        }
        if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
        setMode({ ...mode, text: editText(mode.text, input, key) });
        return;
      }
      case 'starting':
        if (mode.failed === null) return;
        setMode({ kind: 'list' });
        void refresh();
        return;
      case 'external': {
        const ts = targetsFor(mode.entry);
        if (key.escape) { setMode({ kind: 'list' }); return; }
        const move = (d: number) => {
          openIndexRef.current = Math.max(0, Math.min(ts.length - 1, openIndexRef.current + d));
          setMode({ ...mode, index: openIndexRef.current });
        };
        if (key.upArrow || input === 'k') { move(-1); return; }
        if (key.downArrow || input === 'j') { move(1); return; }
        const n = Number(input);
        const pick = key.return ? ts[Math.min(openIndexRef.current, ts.length - 1)] : n >= 1 ? ts[n - 1] : undefined;
        if (pick) { setMode({ kind: 'list' }); void openUrl(pick); }
        return;
      }
      case 'list':
        break;
    }

    if (key.ctrl && input === 'x') {
      if (current) ctrlX(current);
      return;
    }
    // Any other key cancels a pending delete.
    if (pendingRef.current) { pendingRef.current = null; setMessage(null); if (key.escape) return; }
    if (key.upArrow || input === 'k') {
      const e = list[Math.max(0, cursor - 1)];
      if (e) setCursorId(e.row.sessionId);
    } else if (key.downArrow || input === 'j') {
      const e = list[Math.min(list.length - 1, cursor + 1)];
      if (e) setCursorId(e.row.sessionId);
    } else if (key.return) {
      if (!current) return;
      if (current.row.kind === 'background' && current.row.id) {
        void attach(current.row.id);
      } else {
        setMode({ kind: 'info', entry: current });
      }
    } else if (input === 'r') {
      // The list often looks the same after a refresh, so say it happened.
      setMessage(null);
      loadUsage();
      void refresh().then(() => {
        setMessage('Refreshed.');
        setTimeout(() => setMessage((m) => (m === 'Refreshed.' ? null : m)), 2000);
      });
    } else if (input === 'h') {
      if (!current) return;
      const sid = current.row.sessionId;
      const label = current.row.name ?? sid.slice(0, 8);
      if (heldRef.current.has(sid)) {
        updateHeld((h) => h.delete(sid));
        setMessage(`${label} is back in the list.`);
      } else {
        // Move on to the next row: holding says "not now", so the cursor should not follow it down.
        const shown = [...(last ? [last] : []), ...rest];
        const i = shown.indexOf(current);
        const next = shown[i + 1] ?? shown[i - 1];
        updateHeld((h) => h.add(sid));
        if (next) setCursorId(next.row.sessionId);
        setMessage(`Put ${label} on hold. It comes back when you attach and work on it, or press h on it.`);
      }
    } else if (input === 'e') {
      setMessage(null);
      openIndexRef.current = 0;
      if (current) setMode({ kind: 'external', entry: current, index: 0 });
    } else if (input === 'n') {
      setMessage(null);
      openPicker();
    } else if (input === 'q') {
      exit();
    }
  });

  const rows = stdout.rows ?? 24;
  const cols = stdout.columns ?? 80;
  const ago = refreshing ? 'refreshing...' : lastRefresh === null ? '' : `updated ${formatWait(lastRefresh, now)} ago`;

  const header = (
    <Box flexDirection="column">
      <Box>
        <Text bold>whatnext</Text>
        <Text dimColor>{`  ${loaded && !error ? `${entries.length} session${entries.length === 1 ? '' : 's'} · ` : ''}${ago}`}</Text>
      </Box>
      {usage.length > 0 && (
        <Text wrap="truncate">
          {usage.map((u, i) => (
            <Text key={u.label}>
              {i > 0 ? <Text dimColor>{' · '}</Text> : null}
              <Text dimColor>{`${u.label} `}</Text>
              <Text color={u.percent >= 80 ? 'red' : u.percent >= 50 ? 'yellow' : undefined}>{`${u.percent}%`}</Text>
              {u.resets ? <Text dimColor>{` (resets ${u.resets})`}</Text> : null}
            </Text>
          ))}
        </Text>
      )}
    </Box>
  );

  if (mode.kind === 'info') {
    const r = mode.entry.row;
    return (
      <Box flexDirection="column">
        {header}
        <Text> </Text>
        <Text>{`${r.name ?? r.sessionId} is an interactive session and cannot be attached. Find it here:`}</Text>
        <Text>{`  cwd: ${r.cwd}`}</Text>
        <Text>{`  pid: ${r.pid ?? 'unknown'}`}</Text>
        <Text> </Text>
        <Text dimColor>Press any key to return to the list.</Text>
      </Box>
    );
  }

  if (mode.kind === 'pickDir') {
    const shown: (Candidate | null)[] = [...filter(mode.items ?? [], mode.query), null];
    const max = Math.max(3, rows - 7);
    const start = Math.max(0, Math.min(mode.index - Math.floor(max / 2), shown.length - max));
    return (
      <Box flexDirection="column">
        {header}
        <Text> </Text>
        <Text>{'New session — working directory: '}<Text color="cyan">{mode.query}</Text><Text inverse> </Text></Text>
        {mode.items === null && <Text dimColor>Loading candidates...</Text>}
        {shown.slice(start, start + max).map((s, i) => (
          <Text key={s?.path ?? ''} inverse={start + i === mode.index} wrap="truncate-start">{s?.label ?? 'Other...'}</Text>
        ))}
        <Text dimColor>Type to filter · ↑↓ select · Enter choose · Esc cancel</Text>
      </Box>
    );
  }

  if (mode.kind === 'pickModel') {
    return (
      <Box flexDirection="column">
        {header}
        <Text> </Text>
        <Text>{`New session in ${mode.dir}`}</Text>
        <Text>Model:</Text>
        {['default', 'Other...'].map((label, i) => (
          <Text key={label} inverse={i === mode.index}>{label}</Text>
        ))}
        <Text dimColor>↑↓ select · Enter choose · Esc cancel</Text>
      </Box>
    );
  }

  if (mode.kind === 'otherDir' || mode.kind === 'model') {
    return (
      <Box flexDirection="column">
        {header}
        <Text> </Text>
        {mode.kind === 'otherDir' ? (
          <Text>{'New session — working directory: '}<Text color="cyan">{mode.text}</Text><Text inverse> </Text></Text>
        ) : (
          <>
            <Text>{`New session in ${mode.dir}`}</Text>
            <Text>{'Model: '}<Text color="cyan">{mode.text}</Text><Text inverse> </Text></Text>
          </>
        )}
        {message && <Text color="red">{message}</Text>}
        <Text dimColor>{mode.kind === 'model' ? 'Enter confirm · Esc back' : 'Enter confirm · Esc cancel'}</Text>
      </Box>
    );
  }

  if (mode.kind === 'starting') {
    return (
      <Box flexDirection="column">
        {header}
        <Text> </Text>
        <Text>{`New session in ${mode.dir}`}</Text>
        <Text>{`Model: ${mode.model || '(default)'}`}</Text>
        <Text> </Text>
        {mode.failed === null ? (
          <Text color="cyan">{`Starting session... ${Math.max(0, Math.floor((now - mode.at) / 1000))}s`}</Text>
        ) : (
          <>
            <Text color="red">Could not start the session:</Text>
            <Text>{mode.failed}</Text>
            <Text> </Text>
            <Text dimColor>Press any key to return to the list.</Text>
          </>
        )}
      </Box>
    );
  }

  const tierW = Math.max(4, ...entries.map((e) => tierLabel(e).length));
  const costs = new Map(entries.map((e) => [e.row.sessionId, formatCost(otelRef.current.costOf(e.row.sessionId))]));
  const costW = Math.max(0, ...[...costs.values()].map((c) => c.length));
  const ctxs = new Map(entries.map((e) => [e.row.sessionId, formatTokens(otelRef.current.contextOf(e.row.sessionId))]));
  const ctxW = Math.max(0, ...[...ctxs.values()].map((c) => c.length));
  const nameW = Math.min(32, Math.max(7, ...entries.map((e) => (e.row.name ?? '').length + (e.row.kind === 'interactive' ? 6 : 0))));
  const maxRows = Math.max(3, rows - 6 - (usage.length > 0 ? 1 : 0));
  // The last-attached group and the ladder heading stay put; the ladder and the on-hold group scroll.
  const upNext = (last !== null || onHold.length > 0) && rest.length > 0;
  const fixed = (last ? 2 + (rest.length + onHold.length > 0 ? 1 : 0) : 0) + (upNext ? 1 : 0);
  type Item = { entry: Entry } | { heading: string } | { blank: true };
  const items: Item[] = [
    ...rest.map((entry) => ({ entry })),
    ...(onHold.length > 0 ? [...(rest.length > 0 ? [{ blank: true as const }] : []), { heading: 'On hold' }] : []),
    ...onHold.map((entry) => ({ entry })),
  ];
  const regionRows = Math.max(1, maxRows - fixed);
  const pos = Math.max(0, items.findIndex((it) => 'entry' in it && it.entry === current));
  const start = Math.max(0, Math.min(pos - Math.floor(regionRows / 2), items.length - regionRows));
  const renderRow = (e: Entry, sel: boolean) => {
    const w = where.get(e.row.cwd);
    const name = `${e.row.name ?? e.row.sessionId.slice(0, 8)}${e.row.kind === 'interactive' ? ' (tty)' : ''}`;
    return (
      <Box key={e.row.sessionId}>
        <Box width={2}><Text color="cyan">{sel ? '›' : ' '}</Text></Box>
        <Box width={tierW + 2}><Text color={TIER_COLOR[e.tier]} bold={sel}>{tierLabel(e)}</Text></Box>
        <Box width={9}><Text bold={sel}>{formatWait(e.since, now).padStart(7)}</Text></Box>
        <Box width={nameW + 2}><Text bold={sel} wrap="truncate">{name}</Text></Box>
        {ctxW > 0 && <Box width={Math.max(3, ctxW) + 2}><Text bold={sel}>{(ctxs.get(e.row.sessionId) ?? '').padStart(Math.max(3, ctxW))}</Text></Box>}
        {costW > 0 && <Box width={Math.max(4, costW) + 2}><Text bold={sel}>{(costs.get(e.row.sessionId) ?? '').padStart(Math.max(4, costW))}</Text></Box>}
        <Box flexGrow={1}>
          <Text wrap="truncate">
            {whereText(e.row.cwd, w?.git)}
            {w?.pr ? <Text color={PR_COLOR[w.pr.state]}>{` #${w.pr.number} (${w.pr.state})`}</Text> : null}
          </Text>
        </Box>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" width={cols}>
      {header}
      <Text> </Text>
      {!loaded && <Text dimColor>Loading sessions...</Text>}
      {error && <Text color="red">{`Could not read sessions from claude agents --json: ${error}`}</Text>}
      {loaded && !error && entries.length === 0 && <Text>No sessions need attention (nothing waiting, failed, done or working).</Text>}
      {entries.length > 0 && (
        <Box>
          <Box width={2} />
          <Box width={tierW + 2}><Text dimColor>TIER</Text></Box>
          <Box width={9}><Text dimColor>WAITING</Text></Box>
          <Box width={nameW + 2}><Text dimColor>SESSION</Text></Box>
          {ctxW > 0 && <Box width={Math.max(3, ctxW) + 2}><Text dimColor>CTX</Text></Box>}
          {costW > 0 && <Box width={Math.max(4, costW) + 2}><Text dimColor>COST</Text></Box>}
          <Text dimColor>WHERE</Text>
        </Box>
      )}
      {last && <Text dimColor>{'  Last attached'}</Text>}
      {last && renderRow(last, current === last)}
      {last && rest.length + onHold.length > 0 && <Text> </Text>}
      {upNext && <Text dimColor>{'  Up next'}</Text>}
      {items.slice(start, start + regionRows).map((it, i) =>
        'entry' in it ? renderRow(it.entry, it.entry === current)
          : 'heading' in it ? <Text key={`h${start + i}`} dimColor>{`  ${it.heading}`}</Text>
            : <Text key={`b${start + i}`}> </Text>)}
      {items.length > regionRows && <Text dimColor>{`  ${cursor + 1}/${list.length}`}</Text>}
      <Text> </Text>
      {message && <Text color="yellow">{message}</Text>}
      {mode.kind === 'discard' && (
        <Text color="red">{`Discard ${mode.count} unpushed commit${mode.count === 1 ? '' : 's'} and delete session ${mode.id}? [y/N]`}</Text>
      )}
      {mode.kind === 'external' && (() => {
        const w = where.get(mode.entry.row.cwd);
        const ts = targetsFor(mode.entry);
        return (
          <Box flexDirection="column">
            <Text>{`Show ${mode.entry.row.name ?? mode.entry.row.sessionId.slice(0, 8)} in:`}</Text>
            {ts.map((t, i) => (
              <Text key={t.url} inverse={i === Math.min(mode.index, ts.length - 1)} wrap="truncate-middle">{`${i + 1}. ${t.label}`}</Text>
            ))}
            {!w?.pr && <Text dimColor>No PR found for this session.</Text>}
            <Text dimColor>↑↓ select · Enter or 1-9 open · Esc cancel</Text>
          </Box>
        );
      })()}
      {mode.kind !== 'external' && <Text dimColor>↑↓ move · Enter attach · h hold · e external · n new · Ctrl+X stop/delete · r refresh · q quit</Text>}
    </Box>
  );
}
