import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import { Observer, cursorAfterAttach, formatDuration, tierText, type ListItem } from './ladder.js';
import { gitInfo, isDefaultBranch, prFor, summarizeWhere, type GitInfo, type PrInfo } from './gitinfo.js';
import { attach, fetchAgents, ghqRepos, isGitRepo, removeSession, repoRoot, startSession, stopSession } from './claude.js';
import { fuzzyFilter } from './fuzzy.js';

const REFRESH_INTERVAL_MS = 60_000;
const DELETE_WINDOW_MS = 2_000;

type Mode =
  | { kind: 'list' }
  | { kind: 'confirmStop'; id: string }
  | { kind: 'newDir'; candidates: string[]; query: string; index: number }
  | { kind: 'newDirOther'; value: string; error?: string }
  | { kind: 'newWorktree'; cwd: string }
  | { kind: 'newModel'; cwd: string; worktree: boolean; value: string }
  | { kind: 'newPrompt'; cwd: string; worktree: boolean; model: string; value: string; error?: string }
  | { kind: 'busy'; label: string };

const OTHER = 'Other...';
const DIR_ROWS = 10;

function tildify(p: string | null | undefined): string {
  if (!p) return '-';
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// 絞り込みは見えている表記(~ 始まり)に対して行う。Other... は常に末尾
function dirChoices(candidates: string[], query: string): string[] {
  const shown = candidates.map(tildify);
  const byShown = new Map(shown.map((d, i) => [d, candidates[i]]));
  return [...fuzzyFilter(shown, query).map((d) => byShown.get(d)!), OTHER];
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

const prKey = (g: GitInfo) => `${g.top}\0${g.branch}`;

const PR_COLOR: Record<PrInfo['state'], string> = { open: 'green', draft: 'gray', merged: 'magenta', closed: 'gray' };

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
  const [git, setGit] = useState<Record<string, GitInfo | null>>({});
  const [prs, setPrs] = useState<Record<string, PrInfo | null>>({});
  const attached = useRef(false);
  const deleteArm = useRef<{ id: string; until: number; stopping: boolean; deleteRequested: boolean } | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async (select?: (items: ListItem[]) => string | undefined): Promise<void> => {
    // 進行中の更新があれば終わるのを待ち、操作の結果を反映した状態で読み直す
    while (inFlight.current) await inFlight.current;
    const run = doRefresh(select);
    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
    }
  }, []);

  const doRefresh = async (select?: (items: ListItem[]) => string | undefined) => {
    setRefreshing(true);
    const r = await fetchAgents();
    const t = Date.now();
    if (r.ok) {
      const next = observer.current.observe(r.rows, t);
      // ブランチと worktree はローカルの git で速く取れるので、一覧と一緒に出す
      const cwds = [...new Set(next.map((i) => i.row.cwd).filter((c): c is string => !!c))];
      const infos = await Promise.all(cwds.map((c) => gitInfo(c)));
      const byCwd = Object.fromEntries(cwds.map((c, i) => [c, infos[i]]));
      setGit(byCwd);
      setItems(next);
      // PR は gh のネットワーク往復を待たずに、分かったものから埋める(#12)。既定のブランチは引かない
      const targets = new Map<string, GitInfo>();
      for (const g of infos) if (g?.branch && !isDefaultBranch(g)) targets.set(prKey(g), g);
      for (const [key, g] of targets) void prFor(g.top, g.branch!).then((pr) => setPrs((cur) => ({ ...cur, [key]: pr })));
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
  };

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
    const left = { sessionId: item.row.sessionId, tier: item.tier };
    attached.current = true;
    let result: Awaited<ReturnType<typeof attach>> | undefined;
    try {
      await suspendTerminal(async () => {
        result = await attach(id);
      });
    } finally {
      attached.current = false;
    }
    if (result?.error) setMessage(`Could not attach to session ${id}: ${result.error}`);
    else if (result && result.code !== 0) setMessage(`Detached from session ${id} (claude attach exited with ${result.signal ?? `code ${result.code}`}).`);
    else setMessage(`Detached from session ${id}.`);
    // 戻ったら先頭(次にやるセッション)にカーソルを置く
    await refresh((next) => cursorAfterAttach(next, left));
  };

  const openNew = async () => {
    setMode({ kind: 'busy', label: 'Collecting directories...' });
    const dirs = [launchDir];
    const [roots, ghq] = await Promise.all([
      Promise.all(list.map((i) => i.row.cwd).filter((c): c is string => !!c).map((c) => repoRoot(c))),
      ghqRepos(),
    ]);
    for (const d of [...roots, ...ghq]) if (!dirs.includes(d) && fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) dirs.push(d);
    setMode({ kind: 'newDir', candidates: dirs, query: '', index: 0 });
  };

  // git のリポジトリのときだけ worktree を使うかを聞く
  const chooseDir = async (cwd: string) => {
    setMode({ kind: 'busy', label: 'Checking directory...' });
    if (await isGitRepo(cwd)) setMode({ kind: 'newWorktree', cwd });
    else setMode({ kind: 'newModel', cwd, worktree: false, value: '' });
  };

  const launch = async (cwd: string, worktree: boolean, model: string, prompt: string) => {
    setMode({ kind: 'busy', label: 'Starting session...' });
    const r = await startSession({ cwd, worktree, model, prompt });
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

  // メッセージではセッションを id で示す。名前は利用者のデータで英語とは限らないので、一覧の NAME 列にだけ出す
  const doDelete = async (id: string) => {
    setMessage(`Deleting session ${id}...`);
    const r = await removeSession(id);
    setMessage(r.ok ? `Deleted session ${id}.` : `Could not delete session ${id}: ${r.message}`);
    await refresh();
  };

  // Agent View と同じ: 1回目で止め、2秒以内の2回目で削除する(#10)
  const ctrlX = () => {
    const arm = deleteArm.current;
    if (arm && (arm.stopping || Date.now() <= arm.until)) {
      if (arm.stopping) {
        arm.deleteRequested = true;
        return;
      }
      deleteArm.current = null;
      void doDelete(arm.id);
      return;
    }
    if (!current) return;
    if (current.row.kind !== 'background' || !current.row.id) {
      setMessage('Interactive sessions cannot be stopped or deleted from whatnext (no id).');
      return;
    }
    const id = current.row.id;
    const armed = { id, until: Date.now() + DELETE_WINDOW_MS, stopping: true, deleteRequested: false };
    deleteArm.current = armed;
    setMessage(`Stopping session ${id}...`);
    void stopSession(id).then(async (r) => {
      const stopped = r.ok ? `Stopped session ${id}.` : `Could not stop session ${id}: ${r.message}.`;
      if (deleteArm.current !== armed) {
        // Esc などで取り消された
        setMessage(stopped);
        return void refresh();
      }
      armed.stopping = false;
      if (armed.deleteRequested) {
        deleteArm.current = null;
        return void doDelete(id);
      }
      // 止める操作に時間がかかっても、結果を見てから2秒は削除を受け付ける
      armed.until = Math.max(armed.until, Date.now() + DELETE_WINDOW_MS);
      setMessage(`${stopped} Press Ctrl+X again within 2 seconds to delete it (Esc to cancel).`);
      setTimeout(() => {
        if (deleteArm.current !== armed) return;
        deleteArm.current = null;
        setMessage(stopped);
      }, armed.until - Date.now() + 50);
      await refresh();
    });
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
          setMode({ kind: 'busy', label: `Stopping session ${id}...` });
          void stopSession(id).then(async (r) => {
            setMessage(r.ok ? r.message : `Could not stop session ${id}: ${r.message}`);
            setMode({ kind: 'list' });
            await refresh();
          });
        } else {
          setMessage('Stop cancelled.');
        }
        return;
      }
      case 'newDir': {
        // 文字は絞り込みに使うので、移動は矢印と Ctrl+P/N だけにする
        const choices = dirChoices(mode.candidates, mode.query);
        if (key.escape) return setMode({ kind: 'list' });
        if (key.upArrow || (key.ctrl && input === 'p')) return setMode({ ...mode, index: Math.max(0, mode.index - 1) });
        if (key.downArrow || (key.ctrl && input === 'n')) return setMode({ ...mode, index: Math.min(choices.length - 1, mode.index + 1) });
        if (key.return) {
          const choice = choices[Math.min(mode.index, choices.length - 1)];
          if (choice === OTHER) setMode({ kind: 'newDirOther', value: mode.query.trim() });
          else void chooseDir(choice);
          return;
        }
        const v = editText(mode.query, input, key);
        if (v !== null) setMode({ ...mode, query: v, index: 0 });
        return;
      }
      case 'newDirOther': {
        if (key.escape) return setMode({ kind: 'list' });
        if (key.return) {
          const raw = mode.value.trim().replace(/^~(?=$|\/)/, os.homedir());
          if (!raw) return;
          const v = path.resolve(launchDir, raw);
          if (!fs.statSync(v, { throwIfNoEntry: false })?.isDirectory()) return setMode({ ...mode, error: `Not a directory: ${v}` });
          void chooseDir(v);
          return;
        }
        const v = editText(mode.value, input, key);
        if (v !== null) setMode({ ...mode, value: v, error: undefined });
        return;
      }
      case 'newWorktree': {
        if (key.escape) return setMode({ kind: 'list' });
        // 既定は worktree を使う
        if (key.return || input === 'y' || input === 'Y') return setMode({ kind: 'newModel', cwd: mode.cwd, worktree: true, value: '' });
        if (input === 'n' || input === 'N') return setMode({ kind: 'newModel', cwd: mode.cwd, worktree: false, value: '' });
        return;
      }
      case 'newModel': {
        if (key.escape) return setMode({ kind: 'list' });
        if (key.return) return setMode({ kind: 'newPrompt', cwd: mode.cwd, worktree: mode.worktree, model: mode.value.trim(), value: '' });
        const v = editText(mode.value, input, key);
        if (v !== null) setMode({ ...mode, value: v });
        return;
      }
      case 'newPrompt': {
        if (key.escape) return setMode({ kind: 'list' });
        if (key.return) {
          if (!mode.value.trim()) return setMode({ ...mode, error: 'Prompt is required.' });
          void launch(mode.cwd, mode.worktree, mode.model, mode.value.trim());
          return;
        }
        const v = editText(mode.value, input, key);
        if (v !== null) setMode({ ...mode, value: v, error: undefined });
        return;
      }
      case 'list':
        break;
    }

    if (key.ctrl && input === 'x') return ctrlX();
    // 削除の待ち受け中に Ctrl+X 以外を押したら取り消す(別の行を消してしまわないように)
    if (deleteArm.current) {
      deleteArm.current = null;
      if (key.escape) return setMessage('Delete cancelled.');
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
        setMode({ kind: 'confirmStop', id: current.row.id });
      } else {
        setMessage('Interactive sessions cannot be stopped from whatnext (no id).');
      }
    }
  });

  const width = stdout.columns || 100;
  const nameWidth = Math.max(12, Math.min(28, Math.floor(width * 0.18)));
  // 段の列は、理由を添えた行があるときだけ広げる
  const tierWidth = Math.min(26, Math.max(10, ...(items ?? []).map((i) => stringWidth(tierText(i.tier, i.reason))))) + 1;
  const whereWidth = Math.max(10, width - 2 - tierWidth - 9 - (nameWidth + 1) - 1);

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
          <Text dimColor wrap="truncate-end">
            {'  '}
            {'TIER'.padEnd(tierWidth)}
            {'WAITING'.padEnd(9)}
            {'SESSION'.padEnd(nameWidth + 1)}
            WHERE
          </Text>
        </Box>
        {items.map((item, i) => {
          const sel = i === cursor;
          const wait = formatDuration(item.since === null ? null : now - item.since);
          // 大半は background なので、interactive のときだけ (tty) を添える
          const name = (item.row.name || item.row.id || item.row.sessionId.slice(0, 8)) + (item.row.kind === 'background' ? '' : ' (tty)');
          const g = item.row.cwd ? git[item.row.cwd] : null;
          const where = summarizeWhere(g, tildify(item.row.cwd));
          const pr = g?.branch && !isDefaultBranch(g) ? prs[prKey(g)] : null;
          const prText = pr ? ` #${pr.number}` : '';
          const color = item.tier === 'failed' ? 'red' : item.tier === 'working' ? 'gray' : item.tier === 'review' ? 'cyan' : 'yellow';
          return (
            <Box key={item.row.sessionId}>
              <Text inverse={sel} wrap="truncate-end">
                {sel ? '> ' : '  '}
                <Text color={color}>{fit(tierText(item.tier, item.reason), tierWidth)}</Text>
                {wait.padEnd(9)}
                {fit(name, nameWidth + 1)}
                {tail(where, whereWidth - prText.length)}
                {pr ? <Text color={PR_COLOR[pr.state]}>{prText}</Text> : null}
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
          Stop session {mode.id}? The in-progress turn will be lost. [y/N]
        </Text>
      );
      break;
    case 'newDir': {
      const choices = dirChoices(mode.candidates, mode.query);
      const index = Math.min(mode.index, choices.length - 1);
      // 選んでいる行が見える範囲だけを出す
      const start = Math.max(0, Math.min(index - DIR_ROWS + 1, choices.length - DIR_ROWS));
      const shown = choices.slice(start, start + DIR_ROWS);
      panel = (
        <Box flexDirection="column">
          <Text bold>New session — working directory (type to filter, ↑↓ select, Enter confirm, Esc cancel)</Text>
          <Text>
            Filter: {mode.query}
            <Text inverse> </Text>
            <Text dimColor>  {choices.length - 1}/{mode.candidates.length}</Text>
          </Text>
          {start > 0 ? <Text dimColor>  ↑ {start} more</Text> : null}
          {shown.map((c, i) => (
            <Text key={c} inverse={start + i === index}>
              {start + i === index ? '> ' : '  '}
              {c === OTHER ? c : tildify(c)}
            </Text>
          ))}
          {start + shown.length < choices.length ? <Text dimColor>  ↓ {choices.length - start - shown.length} more</Text> : null}
        </Box>
      );
      break;
    }
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
    case 'newWorktree':
      panel = (
        <Text bold>
          New session in {tildify(mode.cwd)} — use a new git worktree? [Y/n] (Esc cancel)
        </Text>
      );
      break;
    case 'newModel':
      panel = (
        <Box flexDirection="column">
          <Text bold>New session in {tildify(mode.cwd)}{mode.worktree ? ' (worktree)' : ''} — model (optional, Enter to use the default, Esc cancel)</Text>
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
            {mode.worktree ? ' (worktree)' : ''}
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
          <Text dimColor>↑↓/jk move  Enter attach (Ctrl+Z to come back)  n new  s stop  ^X stop/delete  r refresh  q quit</Text>
        </Box>
      ) : null}
    </Box>
  );
}
