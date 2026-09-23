import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import { Observer, TIER_LABEL, formatDuration, type ListItem } from './ladder.js';
import { attach, fetchAgents, repoRoot, startSession, stopSession } from './claude.js';

const REFRESH_INTERVAL_MS = 60_000;

type Mode =
  | { kind: 'list' }
  | { kind: 'confirmStop'; id: string; name: string }
  | { kind: 'newDir'; candidates: string[]; index: number }
  | { kind: 'newDirOther'; value: string; error?: string }
  | { kind: 'newModel'; cwd: string; value: string }
  | { kind: 'newPrompt'; cwd: string; model: string; value: string; error?: string }
  | { kind: 'busy'; label: string };

const OTHER = 'Other...';

function tildify(p: string | null | undefined): string {
  if (!p) return '-';
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// 全角文字を2桁と数えて切り詰め・詰め物をする
function fit(s: string, width: number): string {
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + ' '.repeat(width - w);
}

// 長いパスは先頭側を省略し、リポジトリ名が見える末尾を残す
function tail(s: string, width: number): string {
  if (stringWidth(s) <= width) return s;
  let out = '';
  for (const ch of [...s].reverse()) {
    if (stringWidth(out) + stringWidth(ch) > width - 1) break;
    out = ch + out;
  }
  return '…' + out;
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString('en-GB', { hour12: false });
}

export function App({ launchDir }: { launchDir: string }) {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const observer = useRef(new Observer());
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [now, setNow] = useState(Date.now());
  const attached = useRef(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async (select?: (items: ListItem[]) => string | undefined) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    const r = await fetchAgents();
    const t = Date.now();
    if (r.ok) {
      const next = observer.current.observe(r.rows, t);
      setItems(next);
      setError(null);
      setSelected((cur) => {
        const want = select?.(next) ?? cur;
        // カーソルは選んでいたセッションに付いていく。消えたら最上位に戻る
        return next.some((i) => i.row.sessionId === want) ? want! : next[0]?.row.sessionId ?? null;
      });
    } else {
      // 古い一覧は出さない
      setItems(null);
      setError(r.error);
    }
    setLastRefresh(t);
    setRefreshing(false);
    inFlight.current = false;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 最後の更新から60秒で更新する。経過秒数の表示のために毎秒描き直す
  useEffect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (!attached.current && lastRefresh !== null && t - lastRefresh >= REFRESH_INTERVAL_MS) void refresh();
    }, 1000);
    return () => clearInterval(timer);
  }, [lastRefresh, refresh]);

  const list = items ?? [];
  const cursor = Math.max(0, list.findIndex((i) => i.row.sessionId === selected));
  const current: ListItem | undefined = list[cursor];

  const doAttach = async (item: ListItem) => {
    const id = item.row.id!;
    attached.current = true;
    let result: Awaited<ReturnType<typeof attach>> | undefined;
    try {
      await suspendTerminal(async () => {
        result = await attach(id);
      });
    } finally {
      attached.current = false;
    }
    if (result?.error) setMessage(`Could not attach to ${id}: ${result.error}`);
    else if (result && result.code !== 0) setMessage(`Detached from ${id} (claude attach exited with ${result.signal ?? `code ${result.code}`}).`);
    else setMessage(`Detached from ${id}.`);
    await refresh();
  };

  const openNew = async () => {
    setMode({ kind: 'busy', label: 'Collecting directories...' });
    const dirs = [launchDir];
    const roots = await Promise.all(
      list.map((i) => i.row.cwd).filter((c): c is string => !!c).map((c) => repoRoot(c)),
    );
    for (const d of roots) if (!dirs.includes(d) && fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) dirs.push(d);
    setMode({ kind: 'newDir', candidates: [...dirs, OTHER], index: 0 });
  };

  const launch = async (cwd: string, model: string, prompt: string) => {
    setMode({ kind: 'busy', label: 'Starting session...' });
    const r = await startSession({ cwd, model, prompt });
    setMessage(r.ok ? r.message : `Failed to start session: ${r.message}`);
    setMode({ kind: 'list' });
    if (r.ok) await refresh((next) => next.find((i) => r.id && i.row.id === r.id)?.row.sessionId);
  };

  const editText = (value: string, input: string, key: any): string | null => {
    if (key.backspace || key.delete) return value.slice(0, -1);
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return null;
    if (input) return value + input.replace(/[\r\n]/g, '');
    return null;
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    switch (mode.kind) {
      case 'busy':
        return;
      case 'confirmStop': {
        const { id } = mode;
        setMode({ kind: 'list' });
        if (input === 'y' || input === 'Y') {
          setMode({ kind: 'busy', label: `Stopping ${id}...` });
          void stopSession(id).then(async (r) => {
            setMessage(r.ok ? r.message : `Failed to stop ${id}: ${r.message}`);
            setMode({ kind: 'list' });
            await refresh();
          });
        } else {
          setMessage('Stop cancelled.');
        }
        return;
      }
      case 'newDir': {
        if (key.escape) return setMode({ kind: 'list' });
        if (key.upArrow || input === 'k') return setMode({ ...mode, index: Math.max(0, mode.index - 1) });
        if (key.downArrow || input === 'j') return setMode({ ...mode, index: Math.min(mode.candidates.length - 1, mode.index + 1) });
        if (key.return) {
          const choice = mode.candidates[mode.index];
          if (choice === OTHER) setMode({ kind: 'newDirOther', value: '' });
          else setMode({ kind: 'newModel', cwd: choice, value: '' });
        }
        return;
      }
      case 'newDirOther': {
        if (key.escape) return setMode({ kind: 'list' });
        if (key.return) {
          const raw = mode.value.trim().replace(/^~(?=$|\/)/, os.homedir());
          if (!raw) return;
          const v = path.resolve(launchDir, raw);
          if (!fs.statSync(v, { throwIfNoEntry: false })?.isDirectory()) return setMode({ ...mode, error: `Not a directory: ${v}` });
          setMode({ kind: 'newModel', cwd: v, value: '' });
          return;
        }
        const v = editText(mode.value, input, key);
        if (v !== null) setMode({ ...mode, value: v, error: undefined });
        return;
      }
      case 'newModel': {
        if (key.escape) return setMode({ kind: 'list' });
        if (key.return) return setMode({ kind: 'newPrompt', cwd: mode.cwd, model: mode.value.trim(), value: '' });
        const v = editText(mode.value, input, key);
        if (v !== null) setMode({ ...mode, value: v });
        return;
      }
      case 'newPrompt': {
        if (key.escape) return setMode({ kind: 'list' });
        if (key.return) {
          if (!mode.value.trim()) return setMode({ ...mode, error: 'Prompt is required.' });
          void launch(mode.cwd, mode.model, mode.value.trim());
          return;
        }
        const v = editText(mode.value, input, key);
        if (v !== null) setMode({ ...mode, value: v, error: undefined });
        return;
      }
      case 'list':
        break;
    }

    if (input === 'q') return exit();
    if (input === 'r') {
      setMessage(null);
      return void refresh();
    }
    if (input === 'n') {
      setMessage(null);
      return void openNew();
    }
    if (key.upArrow || input === 'k') {
      if (list.length) setSelected(list[Math.max(0, cursor - 1)].row.sessionId);
      return;
    }
    if (key.downArrow || input === 'j') {
      if (list.length) setSelected(list[Math.min(list.length - 1, cursor + 1)].row.sessionId);
      return;
    }
    if (!current) return;
    if (key.return) {
      if (current.row.kind === 'background' && current.row.id) {
        setMessage(null);
        void doAttach(current);
      } else {
        setMessage(
          `Interactive session: cannot attach. Find the terminal running it — cwd: ${tildify(current.row.cwd)}  pid: ${current.row.pid ?? 'unknown'}`,
        );
      }
      return;
    }
    if (input === 's') {
      if (current.row.kind === 'background' && current.row.id) {
        setMessage(null);
        setMode({ kind: 'confirmStop', id: current.row.id, name: current.row.name ?? current.row.id });
      } else {
        setMessage('Interactive sessions cannot be stopped from whatnext (no id).');
      }
    }
  });

  const width = stdout.columns || 100;
  const nameWidth = Math.max(12, Math.min(28, Math.floor(width * 0.2)));

  const header = (
    <Box>
      <Text bold>whatnext</Text>
      <Text dimColor>
        {'  '}
        {lastRefresh === null
          ? 'loading...'
          : `updated ${clock(lastRefresh)} (${Math.floor((now - lastRefresh) / 1000)}s ago)`}
        {refreshing && lastRefresh !== null ? '  refreshing...' : ''}
        {items ? `  ${items.length} session${items.length === 1 ? '' : 's'}` : ''}
      </Text>
    </Box>
  );

  let body: React.ReactNode;
  if (error) {
    body = (
      <Box flexDirection="column">
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Will retry on the next refresh (press r to retry now).</Text>
      </Box>
    );
  } else if (items === null) {
    body = <Text dimColor>Loading sessions...</Text>;
  } else if (items.length === 0) {
    body = <Text>No sessions need attention or are running.</Text>;
  } else {
    body = (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>
            {'  '}
            {'TIER'.padEnd(11)}
            {'REASON'.padEnd(20)}
            {'WAITING'.padEnd(9)}
            {'KIND'.padEnd(5)}
            {'NAME'.padEnd(nameWidth + 1)}
            CWD
          </Text>
        </Box>
        {items.map((item, i) => {
          const sel = i === cursor;
          const wait = formatDuration(item.since === null ? null : now - item.since);
          const kind = item.row.kind === 'background' ? 'bg' : 'tty';
          const name = item.row.name || item.row.id || item.row.sessionId.slice(0, 8);
          const color = item.tier === 'failed' ? 'red' : item.tier === 'working' ? 'gray' : item.tier === 'review' ? 'cyan' : 'yellow';
          return (
            <Box key={item.row.sessionId}>
              <Text inverse={sel} wrap="truncate-end">
                {sel ? '> ' : '  '}
                <Text color={color}>{TIER_LABEL[item.tier].padEnd(11)}</Text>
                {fit(item.reason, 20)}
                {wait.padEnd(9)}
                {kind.padEnd(5)}
                {fit(name, nameWidth + 1)}
                {tail(tildify(item.row.cwd), Math.max(10, width - 2 - 11 - 20 - 9 - 5 - nameWidth - 1 - 1))}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  let panel: React.ReactNode = null;
  switch (mode.kind) {
    case 'busy':
      panel = <Text color="yellow">{mode.label}</Text>;
      break;
    case 'confirmStop':
      panel = (
        <Text color="yellow">
          Stop session {mode.name} ({mode.id})? The in-progress turn will be lost. [y/N]
        </Text>
      );
      break;
    case 'newDir':
      panel = (
        <Box flexDirection="column">
          <Text bold>New session — working directory (↑↓ select, Enter confirm, Esc cancel)</Text>
          {mode.candidates.map((c, i) => (
            <Text key={c} inverse={i === mode.index}>
              {i === mode.index ? '> ' : '  '}
              {c === OTHER ? c : tildify(c)}
            </Text>
          ))}
        </Box>
      );
      break;
    case 'newDirOther':
      panel = (
        <Box flexDirection="column">
          <Text bold>New session — working directory (Enter confirm, Esc cancel)</Text>
          <Text>
            Path: {mode.value}
            <Text inverse> </Text>
          </Text>
          {mode.error ? <Text color="red">{mode.error}</Text> : null}
        </Box>
      );
      break;
    case 'newModel':
      panel = (
        <Box flexDirection="column">
          <Text bold>New session in {tildify(mode.cwd)} — model (optional, Enter to use the default, Esc cancel)</Text>
          <Text>
            Model: {mode.value}
            <Text inverse> </Text>
          </Text>
        </Box>
      );
      break;
    case 'newPrompt':
      panel = (
        <Box flexDirection="column">
          <Text bold>
            New session in {tildify(mode.cwd)}
            {mode.model ? ` with ${mode.model}` : ''} — prompt (required, Enter to start, Esc cancel)
          </Text>
          <Text>
            Prompt: {mode.value}
            <Text inverse> </Text>
          </Text>
          {mode.error ? <Text color="red">{mode.error}</Text> : null}
        </Box>
      );
      break;
  }

  return (
    <Box flexDirection="column">
      {header}
      <Box marginTop={1}>{body}</Box>
      {panel ? <Box marginTop={1}>{panel}</Box> : null}
      {message ? (
        <Box marginTop={1}>
          <Text>{message}</Text>
        </Box>
      ) : null}
      {mode.kind === 'list' ? (
        <Box marginTop={1}>
          <Text dimColor>↑↓/jk move  Enter attach (Ctrl+Z to come back)  n new  s stop  r refresh  q quit</Text>
        </Box>
      ) : null}
    </Box>
  );
}
