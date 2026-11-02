import {describe, expect, it} from 'vitest';
import type {Run} from '../input/exec.js';
import {splitWorkbench} from './ghostty.js';

describe('Ghostty の分割に打ち込む文字列', () => {
  it('先頭の空白と exec を1つ付け、改行で終える', async () => {
    let input = '';
    const fake: Run = async (_cmd, args) => {
      input = args[2] ?? '';
      return {code: 0, stdout: 'split\n', stderr: ''};
    };
    expect(await splitWorkbench(fake, "'/bin/echo' hi", {A: 'b'})).toBe('split');
    expect(input).toBe(" exec '/bin/echo' hi\n");
  });
});
