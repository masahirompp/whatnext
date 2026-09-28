import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// 利用者向けのオプションではない。利用者の whatnext の横で確かめるときに分けるためだけに使う。
export const SOCKET = process.env.WHATNEXT_TMUX_SOCKET || 'whatnext';
export const PORT = Number(process.env.WHATNEXT_PORT || 14318);

export const DIST = dirname(fileURLToPath(import.meta.url));
export const CLI = join(DIST, 'cli.js');

export const VERSION: string = (() => {
	try {
		return JSON.parse(readFileSync(join(DIST, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
})();

// tmux に渡す環境。利用者の tmux の中で起動しても、専用サーバを入れ子のクライアントで開く。
export function envWithoutTmux(): NodeJS.ProcessEnv {
	const env = {...process.env};
	delete env.TMUX;
	delete env.TMUX_PANE;
	return env;
}
