import React, {useEffect, useReducer, useState} from 'react';
import {Box, Text, useInput, usePaste, useStdout} from 'ink';
import stringWidth from 'string-width';
import cliTruncate from 'cli-truncate';
import {homedir} from 'node:os';
import {TIER_LABEL, type Tier} from './agents.js';
import type {Node} from './model.js';
import type {Session, Store} from './store.js';
import {formatCtx, formatWait} from './text.js';

const TIER_COLOR: Record<Tier, string> = {
	permission: 'red',
	question: 'yellow',
	sandbox: 'magenta',
	failed: 'redBright',
	review: 'green',
	working: 'cyan',
	waiting: 'gray',
};
const PR_COLOR = {open: 'green', draft: 'gray', merged: 'magenta', closed: 'red'} as const;

const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - stringWidth(s)));
const padL = (s: string, w: number) => ' '.repeat(Math.max(0, w - stringWidth(s))) + s;
const cut = (s: string, w: number) => (stringWidth(s) > w ? cliTruncate(s, Math.max(1, w)) : s);
const tilde = (p: string) => p.replace(homedir(), '~');

type Line = {key: string; el: React.ReactNode; sid?: string};

function useSize() {
	const {stdout} = useStdout();
	const [size, setSize] = useState({w: stdout.columns || 100, h: stdout.rows || 30});
	useEffect(() => {
		const on = () => setSize({w: stdout.columns || 100, h: stdout.rows || 30});
		stdout.on('resize', on);
		return () => void stdout.off('resize', on);
	}, [stdout]);
	return size;
}

export function App({store}: {store: Store}) {
	const [, force] = useReducer((x: number) => x + 1, 0);
	useEffect(() => store.subscribe(force), [store]);
	const {w, h} = useSize();
	useInput((input, key) => store.key(input, key));
	usePaste(text => {
		const m = store.mode;
		const oneLine = text.replace(/[\r\n]+/g, ' ');
		if (m.k === 'input') {
			m.value += oneLine;
			store.emit();
		} else if (m.k === 'wait' || m.k === 'dir') {
			m.filter += oneLine;
			store.emit();
		}
	});
	const now = Date.now();
	const m = store.mode;

	if (m.k === 'dir' || m.k === 'model' || m.k === 'launching' || m.k === 'launchFailed' || (m.k === 'input' && m.full)) {
		return <NewSession store={store} w={w} h={h} />;
	}

	// ---- ヘッダ ----
	const header: Line[] = [
		{
			key: 'title',
			el: (
				<Text wrap="truncate-end">
					<Text bold>whatnext</Text>
					{store.usage?.length ? '  ' : ''}
					{store.usage?.map((u, i) => (
						<Text key={u.label}>
							{i ? ' · ' : ''}
							{u.label}{' '}
							<Text color={u.percent >= 80 ? 'red' : u.percent >= 50 ? 'yellow' : undefined}>{u.percent}%</Text>
							{u.resets ? ` (resets ${u.resets})` : ''}
						</Text>
					))}
				</Text>
			),
		},
	];

	const l = store.layout();
	const tiers = store.tiers();
	const all = [...l.last, ...l.ladder, ...l.hold];
	const sel = store.selected();

	// ---- 列の幅 ----
	const nameText = (n: Node<Session>) => {
		const s = n.s;
		let t = n.rowPrefix + s.name;
		if (s.row.kind === 'interactive') t += ' (tty)';
		if (n.depth > 0 && store.holds.has(s.sid)) t += ' (on hold)';
		return t;
	};
	const statusText = (s: Session) => {
		const t = tiers.get(s.sid) ?? s.own;
		return TIER_LABEL[t] + (s.reason && t === s.own ? ` (${s.reason})` : '');
	};
	const whereParts = (s: Session) => {
		const wh = s.where;
		const base = [wh?.repo ?? tilde(s.row.cwd), wh?.branch, wh?.worktree ? '(wt)' : undefined].filter(Boolean).join(' ');
		const pr = wh?.pr ? `#${wh.pr.number} (${wh.pr.state})` : '';
		return {base, pr, text: pr ? `${base} ${pr}` : base};
	};
	const nameW = Math.min(40,Math.max(7, ...all.map(n => stringWidth(nameText(n)))));
	const statusW = Math.max(6, ...all.map(n => stringWidth(statusText(n.s))));
	const fixedW = 2 + nameW + 2 + statusW + 2 + 2 + 5 + 2 + 7;
	const whereW = Math.max(5, Math.min(Math.max(5, ...all.map(n => stringWidth(whereParts(n.s).text))), w - fixedW));

	const colHeader: Line = {
		key: 'cols',
		el: (
			<Text dimColor wrap="truncate-end">
				{'  ' + pad('SESSION', nameW) + '  ' + pad('STATUS', statusW) + '  ' + pad('WHERE', whereW) + '  ' + padL('CTX', 5) + '  ' + padL('WAITING', 7)}
			</Text>
		),
	};

	const nodeLines = (n: Node<Session>): Line[] => {
		const s = n.s;
		const t = tiers.get(s.sid) ?? s.own;
		const isSel = sel?.sid === s.sid;
		const wp = whereParts(s);
		const baseW = wp.pr ? Math.max(1, whereW - stringWidth(wp.pr) - 1) : whereW;
		const since = s.since === null ? null : Math.max(0, store.lastRefresh - s.since);
		const out: Line[] = [
			{
				key: s.sid,
				sid: s.sid,
				el: (
					<Text wrap="truncate-end" inverse={false}>
						<Text color="cyan" bold>{isSel ? '> ' : '  '}</Text>
						<Text bold={isSel}>{pad(cut(nameText(n), nameW), nameW)}</Text>
						{'  '}
						<Text color={TIER_COLOR[t]}>{pad(statusText(s), statusW)}</Text>
						{'  '}
						{cut(wp.base, baseW)}
						{wp.pr ? ' ' : ''}
						{wp.pr ? <Text color={PR_COLOR[s.where!.pr!.state]}>{cut(wp.pr, whereW)}</Text> : null}
						{' '.repeat(Math.max(0, whereW - stringWidth(cut(wp.text, whereW))))}
						{'  '}
						{padL(formatCtx(store.ctxBySid.get(s.sid)), 5)}
						{'  '}
						{padL(formatWait(since), 7)}
					</Text>
				),
			},
		];
		const note = (k: string, text: string, color?: string) =>
			out.push({
				key: `${s.sid}:${k}`,
				sid: s.sid,
				el: (
					<Text wrap="truncate-end">
						{'  '}
						<Text dimColor>{n.notePrefix}</Text>
						<Text color={color} dimColor={!color}>
							{text}
						</Text>
					</Text>
				),
			});
		const reason = store.holds.get(s.sid);
		if (reason) note('hold', `↳ ${reason}`);
		const done = store.doneNotes.get(s.sid);
		if (done && t !== 'waiting') {
			const names = done.map(x => store.names.get(x) ?? x);
			if (names.length) note('done', `↳ ${names.join(', ')} done`, 'green');
		}
		if (s.note) note('note', s.note);
		if (s.bangs.length) note('bang', `! ${s.bangs.join(' · ')}`, 'cyan');
		if (s.running.length) note('run', `⚙ ${s.running.join(' · ')}`, 'yellow');
		return out;
	};

	const title = (key: string, text: string): Line => ({key, el: <Text bold>{text}</Text>});
	const blank = (key: string): Line => ({key, el: <Text> </Text>});

	const fixed: Line[] = [...header, colHeader];
	const scroll: Line[] = [];
	const showUpNext = l.last.length > 0 || l.hold.length > 0;
	if (store.error) {
		fixed.push({key: 'err', el: <Text color="red" wrap="wrap">{`Could not read claude agents --json: ${store.error}`}</Text>});
	} else if (all.length === 0 && store.lastRefresh) {
		fixed.push({key: 'empty', el: <Text dimColor>No sessions to show. Press n to start one.</Text>});
	} else {
		if (l.last.length) {
			fixed.push(title('t-last', 'Last attached'));
			for (const n of l.last) fixed.push(...nodeLines(n));
		}
		if (showUpNext && l.ladder.length) {
			if (l.last.length) fixed.push(blank('b-up'));
			fixed.push(title('t-up', 'Up next'));
		}
		for (const n of l.ladder) scroll.push(...nodeLines(n));
		if (l.hold.length) {
			scroll.push(blank('b-hold'), title('t-hold', 'On hold'));
			for (const n of l.hold) scroll.push(...nodeLines(n));
		}
	}

	// ---- 下の欄 ----
	const footer: Line[] = [];
	const status = [store.refreshing ? 'refreshing...' : '', store.message ?? ''].filter(Boolean).join('  ');
	// メッセージ(claude rm の断りの文言など)は折り返して全文を出す。占める行数を数えてスクロールの窓から差し引く
	const statusLines = (key: string): Line[] => {
		const rows = status
			? status.split('\n').reduce((a, l) => a + Math.max(1, Math.ceil(stringWidth(l) / Math.max(1, w))), 0)
			: 1;
		const out: Line[] = [{key, el: <Text dimColor={!store.message} wrap="wrap">{status || ' '}</Text>}];
		for (let i = 1; i < rows; i++) out.push({key: `${key}${i}`, el: null});
		return out;
	};
	if (m.k === 'input') {
		footer.push({key: 'in', el: <Text wrap="truncate-start">{m.prompt} {m.value}<Text inverse> </Text></Text>});
		if (m.error) footer.push({key: 'inerr', el: <Text color="red">{m.error}</Text>});
		footer.push({key: 'inhint', el: <Text dimColor>{m.hint ?? 'Enter confirm  Esc cancel'}</Text>});
	} else if (m.k === 'confirm') {
		const rows = Math.max(1, Math.ceil(stringWidth(m.text) / Math.max(1, w)));
		footer.push({key: 'cf', el: <Text color="yellow" wrap="wrap">{m.text}</Text>});
		for (let i = 1; i < rows; i++) footer.push({key: `cf${i}`, el: null});
	} else if (m.k === 'menu') {
		footer.push({key: 'mt', el: <Text bold>{m.title}</Text>});
		m.items.forEach((it, i) =>
			footer.push({key: `mi${i}`, el: <Text wrap="truncate-end">{(i === m.sel ? '> ' : '  ') + `${i + 1} ${it.label}`}</Text>}),
		);
		if (m.note) footer.push({key: 'mn', el: <Text dimColor>{'  ' + m.note}</Text>});
		footer.push({key: 'mh', el: <Text dimColor>↑↓ select  Enter choose  1-9 pick  Esc close</Text>});
	} else if (m.k === 'wait') {
		const items = store.waitItems(m);
		const pn = store.sessions.get(m.sid)?.name ?? '';
		footer.push({key: 'wt', el: <Text bold wrap="truncate-end">{`${pn} waits for: `}<Text>{m.filter}</Text><Text inverse> </Text></Text>});
		const max = 8;
		const start = Math.max(0, Math.min(m.sel - Math.floor(max / 2), items.length - max));
		items.slice(start, start + max).forEach((it, j) => {
			const i = start + j;
			const s = it.s;
			const extra = s ? `  ${statusText(s)}  ${whereParts(s).base}` : '';
			footer.push({
				key: `wi${i}`,
				el: (
					<Text wrap="truncate-end">
						{i === m.sel ? '> ' : '  '}
						{it.sid ? (it.linked ? '✓ ' : '  ') : '+ '}
						{it.label}
						<Text dimColor>{extra}</Text>
					</Text>
				),
			});
		});
		footer.push({key: 'wh', el: <Text dimColor>type to filter  ↑↓ select  Enter link/unlink  Esc close</Text>});
	} else {
		footer.push(...statusLines('st'));
		const c = sel?.bangs.length ? 'c copy ! commands  ' : '';
		footer.push({
			key: 'k1',
			el: <Text dimColor wrap="truncate-end">{`↑↓ select  Enter attach  n new  h hold  w wait for  e external  ${c}^X stop/delete  r refresh  q quit`}</Text>,
		});
		footer.push({key: 'k2', el: <Text dimColor wrap="truncate-end">^Q^Q workbench · ^Q l back · ^Q y ! commands</Text>});
	}
	if (m.k !== 'list') footer.unshift(...statusLines('st2'));

	// ---- スクロール ----
	const avail = Math.max(1, h - fixed.length - footer.length - 1);
	let visible = scroll;
	let position: Line | undefined;
	if (scroll.length > avail) {
		const selIdx = scroll.findIndex(x => x.sid === sel?.sid && !x.key.includes(':'));
		const win = Math.max(1, avail - 1);
		let top = selIdx < 0 ? 0 : selIdx - Math.floor(win / 2);
		top = Math.max(0, Math.min(top, scroll.length - win));
		visible = scroll.slice(top, top + win);
		const order = all.map(n => n.s.sid);
		position = {key: 'pos', el: <Text dimColor>{`${order.indexOf(sel?.sid ?? '') + 1}/${order.length}`}</Text>};
	}

	return (
		<Box flexDirection="column" width={w} height={h}>
			{[...fixed, ...visible, ...(position ? [position] : [])].map(x => (
				<Box key={x.key} height={1} overflow="hidden">
					{x.el}
				</Box>
			))}
			<Box flexGrow={1} />
			{footer.filter(x => x.el !== null).map(x => (
				<Box key={x.key} flexShrink={0}>
					{x.el}
				</Box>
			))}
		</Box>
	);
	void now;
}

function NewSession({store, w, h}: {store: Store; w: number; h: number}) {
	const m = store.mode;
	const lines: React.ReactNode[] = [];
	lines.push(<Text key="t" bold>New session</Text>);
	if (m.k === 'dir') {
		lines.push(<Text key="f" wrap="truncate-end">Directory: {m.filter}<Text inverse> </Text></Text>);
		const items = store.dirItems(m);
		const max = Math.max(3, h - 6);
		const start = Math.max(0, Math.min(m.sel - Math.floor(max / 2), items.length - max));
		items.slice(start, start + max).forEach((it, j) => {
			const i = start + j;
			lines.push(
				<Text key={`d${i}`} wrap="truncate-end">
					{i === m.sel ? '> ' : '  '}
					{it.label}
					{it.path ? <Text dimColor>{'  ' + tilde(it.path)}</Text> : null}
				</Text>,
			);
		});
		lines.push(<Text key="h" dimColor>type to filter  ↑↓ select  Enter choose  Esc back</Text>);
	} else if (m.k === 'input') {
		lines.push(<Text key="p" wrap="truncate-start">{m.prompt} {m.value}<Text inverse> </Text></Text>);
		if (m.error) lines.push(<Text key="e" color="red">{m.error}</Text>);
		lines.push(<Text key="h" dimColor>{m.hint}</Text>);
	} else if (m.k === 'model') {
		lines.push(<Text key="d">Directory: {tilde(m.dir)}</Text>);
		lines.push(<Text key="m">Model:</Text>);
		lines.push(<Text key="m0">{m.sel === 0 ? '> ' : '  '}default</Text>);
		lines.push(<Text key="m1">{m.sel === 1 ? '> ' : '  '}Other...</Text>);
		lines.push(<Text key="h" dimColor>↑↓ select  Enter choose  Esc back</Text>);
	} else if (m.k === 'launching') {
		const secs = Math.floor((Date.now() - m.startedAt) / 1000);
		lines.push(<Text key="d">Directory: {tilde(m.dir)}</Text>);
		lines.push(<Text key="m">Model: {m.model ?? 'default'}</Text>);
		lines.push(<Text key="l" color="cyan">{`Starting the session... ${secs}s`}</Text>);
	} else if (m.k === 'launchFailed') {
		lines.push(<Text key="f" color="red">Could not read the session id from claude --bg:</Text>);
		lines.push(<Text key="o" wrap="wrap">{m.output}</Text>);
		lines.push(<Text key="h" dimColor>Press any key to return to the list.</Text>);
	}
	return (
		<Box flexDirection="column" width={w} height={h}>
			{lines}
		</Box>
	);
}
