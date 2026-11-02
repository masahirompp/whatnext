import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import type {Run} from '../../lib/input/exec.js';
import {splitWorkbench} from '../../lib/tmux/ghostty.js';
import {workbenchCommand} from '../../src/cli/env.js';

// Ghostty の分割に打ち込む `whatnext workbench`(ADR-0015)。一覧が渡すコマンドを `splitWorkbench` に通した文字列を確かめる。

describe('Ghostty の分割に打ち込むコマンド', () => {
  const typed = async (): Promise<string> => {
    const inputs: string[] = [];
    // osascript の引数のうち、打ち込む文字列は改行で終わるもの(並びには頼らない)
    const fake: Run = async (_cmd, args) => {
      inputs.push(...args.filter(a => a.endsWith('\n') && !a.includes('tell application')));
      return {code: 0, stdout: 'split\n', stderr: ''};
    };
    await splitWorkbench(fake, workbenchCommand({node: '/bin/echo', cli: "/tmp/it's/cli.js"}), {});
    expect(inputs).toHaveLength(1);
    return inputs[0] ?? '';
  };

  it('exec は1つだけ付く', async () => {
    expect((await typed()).match(/\bexec\b/g)).toHaveLength(1);
  });

  it.each(['bash', 'zsh', 'sh'])('%s でそのまま動く', async shell => {
    expect(execFileSync(shell, ['-c', await typed()], {encoding: 'utf8'})).toBe("/tmp/it's/cli.js workbench\n");
  });
});
