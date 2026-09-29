// 一覧の1コマを行の配列にする。行はすべて端末の幅に切る(幅を超えると tmux が折り返して画面がずれる)。
import {homedir} from 'node:os';
import {TIER_LABEL, type Tier} from './agents.js';
import type {Node} from './model.js';
import type {Session, Store} from './store.js';
import {bold, color, cut, dim, inverse, pad, padL, width, type Color, type Screen} from './term.js';
import {formatCtx, formatWait} from './text.js';

const TIER_COLOR: Record<Tier, Color> = {
	permission: 'red',
	question: 'yellow',
	sandbox: 'magenta',
	failed: 'redBright',
	review: 'green',
	working: 'cyan',
	waiting: 'gray',
	stopped: 'gray',
};
const PR_COLOR = {open: 'green', draft: 'gray', merged: 'magenta', closed: 'red'} as const;

const tilde = (p: string) => p.replace(homedir(), '~');

// 長い文を端末の幅で折り返す(メッセージや確認の全文を出すため)
function wrap(text: string, w: number): string[] {
	const out: string[] = [];
	for (const para of text.split('\n')) {
		let line = '';
		for (const ch of new Intl.Segmenter().segment(para)) {
			if (width(line + ch.segment) > w) {
				out.push(line);
				line = '';
			}
			line += ch.segment;
		}
		out.push(line);
	}
	return out;
}

type Row = {text: string; sid?: string; main?: boolean};

export function frame(store: Store, {cols: w, rows: h}: Screen): string[] {
	const m = store.mode;
	const fit = (lines: string[]) => lines.map(l => cut(l, w));
	if (m.k === 'dir' || m.k === 'model' || m.k === 'launching' || m.k === 'launchFailed' || (m.k === 'input' && m.full)) {
		return fit(newSession(store, w, h));
	}

	// ---- ヘッダ ----
	const usage = store.usage?.length
		? '  ' +
			store.usage
				.map(u => `${u.label} ${color(u.percent >= 80 ? 'red' : u.percent >= 50 ? 'yellow' : undefined, `${u.percent}%`)}${u.resets ? ` (resets ${u.resets})` : ''}`)
				.join(' · ')
		: '';
	const header = [bold('whatnext') + usage];

	const l = store.layout();
	const tiers = store.tiers();
	const all = [...l.last, ...l.ladder, ...l.hold];
	const sel = store.selected();

	// ---- 列の幅 ----
	const nameText = (n: Node<Session>) => {
		let t = n.rowPrefix + n.s.name;
		if (n.s.row.kind === 'interactive') t += ' (tty)';
		if (n.depth > 0 && store.holds.has(n.s.sid)) t += ' (on hold)';
		return t;
	};
	const statusText = (s: Session) => {
		const b = store.busy.get(s.sid);
		if (b) return b === 'deleting' ? 'Deleting...' : 'Stopping...';
		const t = tiers.get(s.sid) ?? s.own;
		return TIER_LABEL[t] + (s.reason && t === s.own ? ` (${s.reason})` : '');
	};
	const whereParts = (s: Session) => {
		const wh = s.where;
		const base = [wh?.repo ?? tilde(s.row.cwd), wh?.branch, wh?.worktree ? '(wt)' : undefined].filter(Boolean).join(' ');
		const pr = wh?.pr ? `#${wh.pr.number} (${wh.pr.state})` : '';
		return {base, pr, text: pr ? `${base} ${pr}` : base};
	};
	const nameW = Math.min(40, Math.max(7, ...all.map(n => width(nameText(n)))));
	const statusW = Math.max(6, ...all.map(n => width(statusText(n.s))));
	const fixedW = 2 + nameW + 2 + statusW + 2 + 2 + 5 + 2 + 7;
	const whereW = Math.max(5, Math.min(Math.max(5, ...all.map(n => width(whereParts(n.s).text))), w - fixedW));

	const colHeader = dim('  ' + pad('SESSION', nameW) + '  ' + pad('STATUS', statusW) + '  ' + pad('WHERE', whereW) + '  ' + padL('CTX', 5) + '  ' + padL('WAITING', 7));

	const nodeRows = (n: Node<Session>): Row[] => {
		const s = n.s;
		const t = tiers.get(s.sid) ?? s.own;
		const isSel = sel?.sid === s.sid;
		const wp = whereParts(s);
		const since = s.since === null ? null : Math.max(0, store.lastRefresh - s.since);
		const deleting = store.busy.get(s.sid) === 'deleting';
		const mark = color('cyan', bold(isSel ? '> ' : '  '));
		const name = pad(cut(nameText(n), nameW), nameW);
		const status = pad(statusText(s), statusW);
		const ctxText = padL(formatCtx(store.ctxBySid.get(s.sid)), 5);
		const waitText = padL(formatWait(since), 7);
		let line: string;
		if (deleting) {
			// 削除中の行は1つの薄い塊で描く(太字の解除 22m は薄字も解除するので、太字や色を混ぜない)
			line = mark + dim(name + '  ' + status + '  ' + pad(cut(wp.text, whereW), whereW) + '  ' + ctxText + '  ' + waitText);
		} else {
			const baseW = wp.pr ? Math.max(1, whereW - width(wp.pr) - 1) : whereW;
			const base = cut(wp.base, baseW);
			const whereCell = wp.pr ? `${base} ${color(PR_COLOR[s.where!.pr!.state], cut(wp.pr, whereW))}` : base;
			const shown = wp.pr ? `${base} ${cut(wp.pr, whereW)}` : base;
			line = mark + (isSel ? bold(name) : name) + '  ' + color(TIER_COLOR[t], status) + '  ' + whereCell + ' '.repeat(Math.max(0, whereW - width(shown))) + '  ' + ctxText + '  ' + waitText;
		}
		const out: Row[] = [{text: line, sid: s.sid, main: true}];
		const note = (text: string, c?: Color) =>
			out.push({sid: s.sid, text: '  ' + dim(n.notePrefix) + (deleting || !c ? dim(text) : color(c, text))});
		const reason = store.holds.get(s.sid);
		if (reason) note(`↳ ${reason}`);
		const done = store.doneNotes.get(s.sid);
		if (done?.length && t !== 'waiting') note(`↳ ${done.map(x => store.names.get(x) ?? x).join(', ')} done`, 'green');
		if (s.note) note(s.note);
		if (s.bangs.length) note(`! ${s.bangs.join(' · ')}`, 'cyan');
		if (s.running.length) note(`⚙ ${s.running.join(' · ')}`, 'yellow');
		return out;
	};

	const fixed: string[] = [...header, colHeader];
	const scroll: Row[] = [];
	if (store.error) {
		fixed.push(...wrap(`Could not read claude agents --json: ${store.error}`, w).map(x => color('red', x)));
	} else if (all.length === 0 && store.lastRefresh) {
		fixed.push(dim('No sessions to show. Press n to start one.'));
	} else {
		if (l.last.length) {
			fixed.push(bold('Last attached'));
			for (const n of l.last) fixed.push(...nodeRows(n).map(r => r.text));
		}
		if ((l.last.length || l.hold.length) && l.ladder.length) {
			if (l.last.length) fixed.push('');
			fixed.push(bold('Up next'));
		}
		for (const n of l.ladder) scroll.push(...nodeRows(n));
		if (l.hold.length) {
			scroll.push({text: ''}, {text: bold('On hold')});
			for (const n of l.hold) scroll.push(...nodeRows(n));
		}
	}

	// ---- 下の欄 ----
	const footer: string[] = [];
	const statusLine = [store.refreshing ? 'refreshing...' : '', store.message ?? ''].filter(Boolean).join('  ');
	const statusRows = statusLine ? wrap(statusLine, w).map(x => (store.message ? x : dim(x))) : [''];
	if (store.versionNotice) footer.push(...wrap(store.versionNotice, w).map(x => color('yellow', x)));
	if (m.k === 'input') {
		footer.push(...statusRows);
		footer.push(inputLine(m.prompt, m.value, w));
		if (m.error) footer.push(color('red', m.error));
		footer.push(dim(m.hint ?? 'Enter confirm  Esc cancel'));
	} else if (m.k === 'confirm') {
		footer.push(...statusRows);
		footer.push(...wrap(m.text, w).map(x => color('yellow', x)));
	} else if (m.k === 'menu') {
		footer.push(...statusRows);
		footer.push(bold(m.title));
		m.items.forEach((it, i) => footer.push((i === m.sel ? '> ' : '  ') + `${i + 1} ${it.label}`));
		if (m.note) footer.push(dim('  ' + m.note));
		footer.push(dim('↑↓ select  Enter choose  1-9 pick  Esc close'));
	} else if (m.k === 'wait') {
		footer.push(...statusRows);
		const items = store.waitItems(m);
		const pn = store.sessions.get(m.sid)?.name ?? '';
		footer.push(bold(`${pn} waits for: `) + m.filter + inverse(' '));
		const max = 8;
		const start = Math.max(0, Math.min(m.sel - Math.floor(max / 2), items.length - max));
		items.slice(start, start + max).forEach((it, j) => {
			const i = start + j;
			const extra = it.s ? `  ${statusText(it.s)}  ${whereParts(it.s).base}` : '';
			footer.push((i === m.sel ? '> ' : '  ') + (it.sid ? (it.linked ? '✓ ' : '  ') : '+ ') + it.label + dim(extra));
		});
		footer.push(dim('type to filter  ↑↓ select  Enter link/unlink  Esc close'));
	} else {
		footer.push(...statusRows);
		const c = sel?.bangs.length ? 'y copy ! commands  ' : '';
		footer.push(dim(`↑↓ select  Enter attach  n new  h hold  w wait for  e external  ${c}^X stop/delete  r refresh  q quit`));
		footer.push(dim('^Q^Q workbench · ^Q l back · ^Q y ! commands · ^Q e external · ^Q h hold · ^Q^X stop'));
	}

	// ---- スクロール ----
	// 窓は最小でも1行を残し、ヘッダを画面から押し出さない(収まらないときは下の欄を削る)
	let foot = footer;
	const maxFoot = Math.max(0, h - fixed.length - 1);
	if (foot.length > maxFoot) foot = foot.slice(foot.length - maxFoot);
	const avail = Math.max(1, h - fixed.length - foot.length);
	let visible = scroll.map(r => r.text);
	if (scroll.length > avail) {
		// 選んだ行とその注記をひとまとまりとして窓の中央に置く。窓の最後の1行は <n>/<総数>
		const win = Math.max(1, avail - 1);
		const selIdx = scroll.findIndex(r => r.sid === sel?.sid && r.main);
		let selEnd = selIdx + 1;
		while (selIdx >= 0 && selEnd < scroll.length && scroll[selEnd]!.sid === sel?.sid && !scroll[selEnd]!.main) selEnd++;
		let top = selIdx < 0 ? 0 : selIdx - Math.max(0, Math.floor((win - (selEnd - selIdx)) / 2));
		top = Math.max(0, Math.min(top, scroll.length - win));
		visible = scroll.slice(top, top + win).map(r => r.text);
		const order = all.map(n => n.s.sid);
		if (avail > 1) visible.push(dim(`${order.indexOf(sel?.sid ?? '') + 1}/${order.length}`));
	}
	const body = [...fixed, ...visible];
	const gap = Math.max(0, h - body.length - foot.length);
	return fit([...body, ...Array<string>(gap).fill(''), ...foot]);
}

// 入力欄。狭い端末では打っている末尾が見えるように先頭を切る
function inputLine(prompt: string, value: string, w: number): string {
	let v = value;
	while (v && width(`${prompt} ${v} `) > w) v = v.slice(1);
	return `${prompt} ${v}` + inverse(' ');
}

function newSession(store: Store, w: number, h: number): string[] {
	const m = store.mode;
	const lines: string[] = [bold('New session')];
	if (m.k === 'dir') {
		lines.push('Directory: ' + m.filter + inverse(' '));
		const items = store.dirItems(m);
		const max = Math.max(3, h - 4);
		const start = Math.max(0, Math.min(m.sel - Math.floor(max / 2), items.length - max));
		items.slice(start, start + max).forEach((it, j) => {
			const i = start + j;
			lines.push((i === m.sel ? '> ' : '  ') + it.label + (it.path ? dim('  ' + tilde(it.path)) : ''));
		});
		lines.push(dim('type to filter  ↑↓ select  Enter choose  Esc back'));
	} else if (m.k === 'input') {
		lines.push(inputLine(m.prompt, m.value, w));
		if (m.error) lines.push(color('red', m.error));
		lines.push(dim(m.hint ?? ''));
	} else if (m.k === 'model') {
		lines.push(`Directory: ${tilde(m.dir)}`, 'Model:', (m.sel === 0 ? '> ' : '  ') + 'default', (m.sel === 1 ? '> ' : '  ') + 'Other...');
		lines.push(dim('↑↓ select  Enter choose  Esc back'));
	} else if (m.k === 'launching') {
		const secs = Math.floor((Date.now() - m.startedAt) / 1000);
		lines.push(`Directory: ${tilde(m.dir)}`, `Model: ${m.model ?? 'default'}`, color('cyan', `Starting the session... ${secs}s`));
	} else if (m.k === 'launchFailed') {
		lines.push(color('red', 'Could not read the session id from claude --bg:'), ...wrap(m.output, w), dim('Press any key to return to the list.'));
	}
	return lines.slice(0, h);
}
