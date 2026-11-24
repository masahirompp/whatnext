import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {basename} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Harness} from './harness.js';
import {TMP_DIGITS} from './tmpdir.js';

// harness が選ぶ名前(一時ディレクトリと、そこから作る tmux のソケット名)。ここで立てる tmux のサーバは、
// このファイルが決めたソケット名のものだけで、終わりに必ず止める。

const tmux = (socket: string, ...args: string[]) =>
  execFileSync('tmux', ['-L', socket, ...args], {
    encoding: 'utf8',
    env: {...process.env, TMUX: ''},
    stdio: ['ignore', 'pipe', 'ignore'],
  });
const alive = (socket: string) => {
  try {
    tmux(socket, 'list-sessions');
    return true;
  } catch {
    return false;
  }
};

let h: Harness | undefined;
let stale: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (stale) {
    try {
      tmux(stale, 'kill-server');
    } catch {}
  }
  stale = undefined;
  h?.cleanup();
  h = undefined;
});

/** 一時ディレクトリも、その名前の tmux のサーバも無い数字の列と、それを引かせる乱数の値。 */
function freeDigits(): {digits: string; random: number} {
  for (let i = 0; i < 100; i++) {
    const n = Math.floor(Math.random() * 10 ** TMP_DIGITS);
    const digits = String(n).padStart(TMP_DIGITS, '0');
    if (existsSync(`/tmp/wne-${digits}`) || alive(`wno-${digits}`) || alive(`wnx-${digits}`)) continue;
    return {digits, random: (n + 0.5) / 10 ** TMP_DIGITS};
  }
  throw new Error('no free name');
}

describe('harness の名前', () => {
  // WN_KEEP=1 で残したあとに /tmp/wne-* だけを消すと、ディレクトリは無いのに tmux のサーバだけが生きている名前が残る。
  // 名前は数字 6 桁なので、同じ名前を引きうる。引くと、テストが古いサーバにつながる(#382)
  it.each(['wno', 'wnx'])('一時ディレクトリが無く、%s のサーバだけが生きている名前は使わない', kind => {
    const {digits, random} = freeDigits();
    stale = `${kind}-${digits}`;
    tmux(stale, '-f', '/dev/null', 'new-session', '-d', '-s', 'stale', 'sleep 600');
    expect(alive(stale)).toBe(true);

    vi.spyOn(Math, 'random').mockReturnValueOnce(random);
    h = new Harness();

    expect(basename(h.dir)).toMatch(new RegExp(`^wne-\\d{${TMP_DIGITS}}$`));
    expect(basename(h.dir)).not.toBe(`wne-${digits}`);
    expect(h.outer).not.toBe(`wno-${digits}`);
    expect(h.socket).not.toBe(`wnx-${digits}`);
    // 避けた名前のディレクトリは残さず、応答したサーバは止めない(並行に流れている通しのものかもしれない)
    expect(existsSync(`/tmp/wne-${digits}`)).toBe(false);
    expect(tmux(stale, 'list-sessions', '-F', '#{session_name}').trim()).toBe('stale');
  });
});
