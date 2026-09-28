// Claude Code がディレクトリを信頼しているか。~/.claude.json の projects[<dir>].hasTrustDialogAccepted を読むだけで、書かない。
// --bg に断られたあとの確認で、そのディレクトリに承認が書かれたかだけを見る(親の扱いは確かめていないので見ない)
import {readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const configFile = () => join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');

export function isTrusted(dir: string): boolean {
	let projects: Record<string, {hasTrustDialogAccepted?: boolean}>;
	try {
		projects = JSON.parse(readFileSync(configFile(), 'utf8')).projects ?? {};
	} catch {
		return false;
	}
	const keys = [dir];
	try {
		keys.push(realpathSync(dir));
	} catch {}
	return keys.some(k => projects[k]?.hasTrustDialogAccepted === true);
}

export const isNotTrustedOutput = (out: string) => /Workspace not trusted/i.test(out);
