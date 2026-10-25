// 画面の組み立て: 表示幅の計算、切り詰め、色。

import cliTruncate from 'cli-truncate';
import stringWidth from 'string-width';

export const width = (s: string): number => stringWidth(s);

/** 表示幅 `w` に収まるように末尾を `…` で切る。 */
export function truncate(s: string, w: number): string {
  if (w <= 0) return '';
  if (stringWidth(s) <= w) return s;
  return cliTruncate(s, w, {position: 'end'});
}

/** 表示幅 `w` に切ってから右に空白を足す。 */
export function padEnd(s: string, w: number): string {
  const t = truncate(s, w);
  return t + ' '.repeat(Math.max(0, w - stringWidth(t)));
}

export function padStart(s: string, w: number): string {
  const t = truncate(s, w);
  return ' '.repeat(Math.max(0, w - stringWidth(t))) + t;
}

const sgr = (open: string, close: string) => (s: string) => (s === '' ? s : `\x1b[${open}m${s}\x1b[${close}m`);

export const color = {
  bold: sgr('1', '22'),
  dim: sgr('2', '22'),
  red: sgr('31', '39'),
  green: sgr('32', '39'),
  yellow: sgr('33', '39'),
  blue: sgr('34', '39'),
  magenta: sgr('35', '39'),
  cyan: sgr('36', '39'),
  gray: sgr('90', '39'),
  inverse: sgr('7', '27'),
};

/** 色の制御列を除く。 */
export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御列を除くため
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** 1行に収める。改行とタブを空白にする。 */
export function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ');
}
