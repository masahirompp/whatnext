import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { launch, listAgents, rm, stop } from './agents.js';
import { Candidate, candidates, filter } from './launch.js';
import { cursorAfterAttach, Entry, formatWait, observe, Seen, tierLabel } from './rank.js';
import { Git, gitInfo, Pr, prFor, whereText } from './where.js';

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
  | { kind: 'model'; dir: string; text: string }
  | { kind: 'starting'; dir: string; model: string; at: number; failed: string | null }
  | { kind: 'discard'; id: string; value: string; count: number };

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
  const [now, setNow] = useState(Date.now());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [where, setWhere] = useState<Map<string, Where>>(new Map());
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [message, setMessage] = useState<string | null>(null);
  const seenRef = useRef<Seen>(new Map());
  const prevRef = useRef<number | null>(null);
  const busyRef = useRef(false); // attached or refreshing
  const pendingRef = useRef<{ id: string; at: number; stopping: boolean } | null>(null);

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

  // Returns the new entries so callers can act on them without waiting for a render.
  const refresh = useCallback(async (opts: { left?: { sessionId: string; key: string } | null; afterAttach?: boolean } = {}) => {
    const t = Date.now();
    try {
      const rows = await listAgents();
      const { entries: es, seen } = observe(rows, seenRef.current, prevRef.current);
      seenRef.current = seen;
      prevRef.current = t;
      setEntries(es);
      setError(null);
      setCursorId((cur) => {
        if (opts.afterAttach) return es[cursorAfterAttach(es, opts.left ?? null)]?.row.sessionId ?? null;
        if (cur && es.some((e) => e.row.sessionId === cur)) return cur;
        return es[0]?.row.sessionId ?? null;
      });
      loadWhere(es);
    } catch (e) {
      setEntries([]);
      setError(e instanceof Error ? e.message : String(e));
    }
    setLastRefresh(t);
    setLoaded(true);
  }, [loadWhere]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (lastRefresh === null) return;
    const t = setTimeout(() => { if (!busyRef.current) void refresh(); }, Math.max(0, lastRefresh + REFRESH_MS - Date.now()));
    return () => clearTimeout(t);
  }, [lastRefresh, refresh]);

  const cursor = Math.max(0, entries.findIndex((e) => e.row.sessionId === cursorId));
  const current = entries[cursor];

  const attach = useCallback(async (id: string, left: { sessionId: string; key: string } | null) => {
    busyRef.current = true;
    setMessage(null);
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
    await refresh({ left, afterAttach: true });
  }, [suspendTerminal, refresh]);

  const removeEntry = (id: string) => {
    setEntries((es) => es.filter((e) => e.row.id !== id));
    setCursorId((cur) => {
      const gone = entries.find((e) => e.row.id === id)?.row.sessionId;
      if (cur !== gone) return cur;
      return entries.find((e) => e.row.id !== id)?.row.sessionId ?? null;
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
    await attach(r.id, null);
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
          else setMode({ kind: 'model', dir: pick.path, text: '' });
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
          setMode({ kind: 'model', dir, text: '' });
          return;
        }
        if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
        setMode({ ...mode, text: editText(mode.text, input, key) });
        return;
      }
      case 'model': {
        if (key.escape) { setMode({ kind: 'list' }); return; }
        if (key.return) { void startNew(mode.dir, mode.text.trim()); return; }
        if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
        setMode({ ...mode, text: editText(mode.text, input, key) });
        return;
      }
      case 'starting':
        if (mode.failed === null) return;
        setMode({ kind: 'list' });
        void refresh();
        return;
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
      const e = entries[Math.max(0, cursor - 1)];
      if (e) setCursorId(e.row.sessionId);
    } else if (key.downArrow || input === 'j') {
      const e = entries[Math.min(entries.length - 1, cursor + 1)];
      if (e) setCursorId(e.row.sessionId);
    } else if (key.return) {
      if (!current) return;
      if (current.row.kind === 'background' && current.row.id) {
        void attach(current.row.id, { sessionId: current.row.sessionId, key: current.tier });
      } else {
        setMode({ kind: 'info', entry: current });
      }
    } else if (input === 'r') {
      setMessage(null);
      void refresh();
    } else if (input === 'n') {
      setMessage(null);
      openPicker();
    } else if (input === 'q') {
      exit();
    }
  });

  const rows = stdout.rows ?? 24;
  const cols = stdout.columns ?? 80;
  const ago = lastRefresh === null ? '' : `updated ${Math.max(0, Math.floor((now - lastRefresh) / 1000))}s ago`;

  const header = (
    <Box>
      <Text bold>whatnext</Text>
      <Text dimColor>{`  ${loaded && !error ? `${entries.length} session${entries.length === 1 ? '' : 's'} · ` : ''}${ago}`}</Text>
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
            <Text>{'Model (leave empty for the default): '}<Text color="cyan">{mode.text}</Text><Text inverse> </Text></Text>
          </>
        )}
        {message && <Text color="red">{message}</Text>}
        <Text dimColor>Enter confirm · Esc cancel</Text>
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
  const nameW = Math.min(32, Math.max(7, ...entries.map((e) => (e.row.name ?? '').length + (e.row.kind === 'interactive' ? 6 : 0))));
  const maxRows = Math.max(3, rows - 6);
  const start = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), entries.length - maxRows));

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
          <Text dimColor>WHERE</Text>
        </Box>
      )}
      {entries.slice(start, start + maxRows).map((e, i) => {
        const sel = start + i === cursor;
        const w = where.get(e.row.cwd);
        const name = `${e.row.name ?? e.row.sessionId.slice(0, 8)}${e.row.kind === 'interactive' ? ' (tty)' : ''}`;
        return (
          <Box key={e.row.sessionId}>
            <Box width={2}><Text color="cyan">{sel ? '›' : ' '}</Text></Box>
            <Box width={tierW + 2}><Text color={TIER_COLOR[e.tier]} bold={sel}>{tierLabel(e)}</Text></Box>
            <Box width={9}><Text bold={sel}>{formatWait(e.since, now).padStart(7)}</Text></Box>
            <Box width={nameW + 2}><Text bold={sel} wrap="truncate">{name}</Text></Box>
            <Box flexGrow={1}>
              <Text wrap="truncate">
                {whereText(e.row.cwd, w?.git)}
                {w?.pr ? <Text color={PR_COLOR[w.pr.state]}>{` #${w.pr.number}`}</Text> : null}
              </Text>
            </Box>
          </Box>
        );
      })}
      {entries.length > maxRows && <Text dimColor>{`  ${cursor + 1}/${entries.length}`}</Text>}
      <Text> </Text>
      {message && <Text color="yellow">{message}</Text>}
      {mode.kind === 'discard' && (
        <Text color="red">{`Discard ${mode.count} unpushed commit${mode.count === 1 ? '' : 's'} and delete session ${mode.id}? [y/N]`}</Text>
      )}
      <Text dimColor>↑↓ move · Enter attach · n new · Ctrl+X stop/delete · r refresh · q quit</Text>
    </Box>
  );
}
