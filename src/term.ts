// 一覧の端末の層。Ink を使わず、画面全体を1回の write で描き、readline の keypress でキーを受ける
// (DESIGN.md「描画とキー入力」、working-with-the-terminal スキル)。
import readline from 'node:readline';
import cliTruncate from 'cli-truncate';
import stringWidth from 'string-width';

export type Key = {
	name?: string;
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
	sequence: string;
	str?: string; // 文字として入力されたもの(制御文字は含まない)
	paste?: string; // 貼り付け(bracketed paste)をまとめたもの
};

export const width = (s: string) => stringWidth(s);

// 表示幅で切る。色の制御コードを含んでいてもよい
export const cut = (s: string, w: number) => (stringWidth(s) > w ? cliTruncate(s, Math.max(1, w)) : s);
export const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - stringWidth(s)));
export const padL = (s: string, w: number) => ' '.repeat(Math.max(0, w - stringWidth(s))) + s;

// 色と太字、薄字。太字と薄字の解除は同じ 22m なので、薄い範囲には太字を混ぜない
const sgr = (open: string, close: string) => (s: string) => (s ? `\x1b[${open}m${s}\x1b[${close}m` : s);
export const bold = sgr('1', '22');
export const dim = sgr('2', '22');
export const inverse = sgr('7', '27');
const COLORS = {red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36', gray: '90', redBright: '91'} as const;
export type Color = keyof typeof COLORS;
export const color = (c: Color | undefined, s: string) => (c ? sgr(COLORS[c], '39')(s) : s);

export type Screen = {cols: number; rows: number};

const out = process.stdout;

export function screenSize(): Screen {
	return {cols: out.columns || 100, rows: out.rows || 30};
}

// 行の配列を画面に書く。消してから描かず、左上から上書きし、各行の末尾と残りの行を消す。
// 行は呼ぶ側で端末の幅に切っておく(1行でも幅を超えると tmux が折り返し、画面が上にずれる)
export function paint(lines: string[]): void {
	const {rows} = screenSize();
	const body = lines.slice(0, rows).map(l => l + '\x1b[0m\x1b[K').join('\r\n');
	out.write('\x1b[?2026h\x1b[H' + body + '\x1b[J\x1b[?2026l');
}

export function startTerminal(onKey: (key: Key) => void, onResize: () => void): void {
	const stdin = process.stdin;
	readline.emitKeypressEvents(stdin, {escapeCodeTimeout: 30} as unknown as readline.Interface);
	if (stdin.isTTY) stdin.setRawMode(true);
	stdin.resume();
	let pasting: string | null = null;
	stdin.on('keypress', (str: string | undefined, k: {name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string} = {}) => {
		if (k.name === 'paste-start') {
			pasting = '';
			return;
		}
		if (k.name === 'paste-end') {
			const text = pasting ?? '';
			pasting = null;
			onKey({ctrl: false, meta: false, shift: false, sequence: '', paste: text});
			return;
		}
		if (pasting !== null) {
			pasting += str ?? k.sequence ?? '';
			return;
		}
		// Esc 単独は meta 付きで届くので、名前で先に見る
		const isEscape = k.name === 'escape';
		const printable = str !== undefined && !k.ctrl && !isEscape && !(k.meta && str.length > 0 && str.startsWith('\x1b')) && !/[\x00-\x1f\x7f]/.test(str);
		onKey({
			name: k.name,
			ctrl: !!k.ctrl,
			meta: !!k.meta && !isEscape,
			shift: !!k.shift,
			sequence: k.sequence ?? str ?? '',
			str: printable ? str : undefined,
		});
	});
	process.on('SIGWINCH', onResize);
	// 代替画面、カーソルを隠す、bracketed paste
	out.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
}

export function stopTerminal(): void {
	out.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
}
