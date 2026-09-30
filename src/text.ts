// 応答の本文から一言と `!` のコマンドを取り出す(PRODUCT.md「一覧の表示」「`!` のコマンドのコピー」)。

const FENCE = /^\s*(```|~~~)/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE = /^\s*\|/;

function stripMarks(line: string): string {
	let s = line.trim();
	s = s.replace(/^(#{1,6}\s+)/, '');
	s = s.replace(/^(>\s*)+/, '');
	s = s.replace(/^([-*+]\s+)/, '');
	s = s.replace(/^(\d+[.)]\s+)/, '');
	s = s.replace(/^\[[ xX]\]\s+/, '');
	s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
	s = s.replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1$2');
	s = s.replace(/`+/g, '');
	return s.trim();
}

// 最後の応答の冒頭(空行、コードの囲み、表の行、区切り線を飛ばした最初の行から記号を除いたもの)
export function headOf(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const lines = text.split(/\r?\n/);
	let inFence = false;
	let firstInFence: string | undefined;
	for (const line of lines) {
		if (FENCE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			if (firstInFence === undefined && line.trim()) firstInFence = line.trim();
			continue;
		}
		if (!line.trim() || HR.test(line) || TABLE.test(line)) continue;
		const s = stripMarks(line);
		if (s) return oneLine(s);
	}
	return firstInFence ? oneLine(firstInFence) : undefined;
}

export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

// 制御文字(タブを含む)を含むものは拾わない
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// 空白2つ以上のあとの `# ` 以下を外す
export function stripComment(cmd: string): string {
	return cmd.replace(/\s{2,}#\s.*$/, '').replace(/\s{2,}#$/, '').trim();
}

export function bangCommands(text: string | undefined): string[] {
	if (!text) return [];
	const found: string[] = [];
	const add = (raw: string) => {
		if (CONTROL.test(raw)) return;
		const cmd = stripComment(raw);
		if (cmd) found.push(cmd);
	};
	let inFence = false;
	for (const line of text.split(/\r?\n/)) {
		if (FENCE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			const m = /^\s*!\s+(.+)$/.exec(line);
			if (m) add(m[1]!);
			continue;
		}
		for (const m of line.matchAll(/`!\s+([^`]+)`/g)) add(m[1]!);
	}
	return found;
}

// 権限を求めている道具と対象(`Bash: <コマンド>`、`Edit: <ファイル>` など)
export function toolTarget(name: string, input: unknown): string {
	const i = (input ?? {}) as Record<string, unknown>;
	const pick = (...keys: string[]) => {
		for (const k of keys) if (typeof i[k] === 'string' && i[k]) return i[k] as string;
		return undefined;
	};
	const target =
		pick('command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt') ??
		Object.values(i).find((v): v is string => typeof v === 'string');
	return target ? `${name}: ${oneLine(target)}` : name;
}

export function formatWait(ms: number | null): string {
	if (ms === null) return '-';
	const m = Math.floor(ms / 60000);
	if (m < 1) return '<1m';
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
	const d = Math.floor(h / 24);
	return `${d}d${String(h % 24).padStart(2, '0')}h`;
}

export function formatCtx(tokens: number | undefined): string {
	if (tokens === undefined) return '-';
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}
