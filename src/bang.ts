// Copying `!` commands: pbcopy (or OSC 52), and the `ctrl+q y` tmux menu while attached.
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {PORT} from './receiver.js';
import {envWithoutTmux, tmux, tmuxBaseArgs} from './tmux.js';

function pbcopy(text: string): Promise<boolean> {
	return new Promise(resolve => {
		let c;
		try {
			c = spawn('pbcopy', [], {stdio: ['pipe', 'ignore', 'ignore']});
		} catch {
			resolve(false);
			return;
		}
		c.on('error', () => resolve(false));
		c.on('exit', code => resolve(code === 0));
		c.stdin.end(text);
	});
}

export const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;

/**
 * Copy to the clipboard: pbcopy if present, otherwise OSC 52. While attached, OSC 52
 * goes through tmux (`set-buffer -w`) to the given client; in the list, to our stdout.
 */
export async function copyText(text: string, client?: string): Promise<void> {
	if (await pbcopy(text)) return;
	if (client) await tmux(['set-buffer', '-w', '-t', client, '--', text]);
	else process.stdout.write(osc52(text));
}

// tmux formats: `#` is special in menu names and messages
const esc = (s: string) => s.replace(/#/g, '##');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function message(client: string, text: string) {
	void tmux(['display-message', '-c', client, '-d', '2000', esc(text)]);
}

type Pending = {cmds: string[]; client: string; pane: string; workbench: boolean; at: number};
const pending = new Map<string, Pending>();

/**
 * `ctrl+q y`: tmux runs `echo '<session> <client_tty> <pane_id>' | curl …/v1/bang/menu`.
 * `commandsFor` gives the `!` commands of the session `<id>` as of now.
 */
export async function openMenu(body: string, commandsFor: (id: string) => Promise<string[]>) {
	const [session, client, pane] = body.trim().split(/\s+/);
	if (!session || !client || !pane) return;
	const workbench = session.startsWith('sh-');
	const id = workbench ? session.slice(3) : session;
	const cmds = await commandsFor(id);
	if (!cmds.length) {
		message(client, 'No ! commands in the last response.');
		return;
	}
	for (const [k, p] of pending) if (Date.now() - p.at > 10 * 60000) pending.delete(k);
	const token = crypto.randomBytes(8).toString('hex');
	pending.set(token, {cmds, client, pane, workbench, at: Date.now()});
	const items: string[] = [];
	cmds.forEach((c, i) => {
		const pick = `curl -s -m 2 -o /dev/null --data-binary '${token} ${i}' http://127.0.0.1:${PORT}/v1/bang/pick`;
		items.push(esc(clip(c, 70)), i < 9 ? String(i + 1) : '', `run-shell -b "${pick}"`);
	});
	// display-menu does not return until the menu closes; do not wait for it
	const child = spawn(
		'tmux',
		[...tmuxBaseArgs(), 'display-menu', '-c', client, '-t', pane, '-T', 'Copy ! commands', '-x', 'C', '-y', 'C', ...items],
		{stdio: 'ignore', env: envWithoutTmux(), detached: true},
	);
	child.on('error', () => {});
	child.unref();
}

/** A menu item was chosen: copy it, and in the workbench also paste it (no Enter). */
export async function pickFromMenu(body: string) {
	const [token, idx] = body.trim().split(/\s+/);
	const p = token ? pending.get(token) : undefined;
	const cmd = p?.cmds[Number(idx)];
	if (!p || cmd == null) return;
	pending.delete(token!);
	await copyText(cmd, p.client);
	if (p.workbench) {
		await tmux(['set-buffer', '-b', 'wn-bang', '--', cmd]);
		await tmux(['paste-buffer', '-p', '-d', '-b', 'wn-bang', '-t', p.pane]);
	}
	message(p.client, `Copied: ${cmd}`);
}
