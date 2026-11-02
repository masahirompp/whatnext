import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import type {Run} from '../../lib/input/exec.js';
import {splitWorkbench} from '../../lib/tmux/ghostty.js';
import {workbenchCommand} from '../../src/cli/env.js';

// Ghostty の分割に打ち込む `whatnext workbench`(ADR-0015)。

describe('Ghostty の分割に打ち込むコマンド', () => {
  const typed = async (): Promise<string> => {
    let input = '';
    const fake: Run = async (_cmd, args) => {
      input = args[2] ?? '';
      return {code: 0, stdout: 'split\n', stderr: ''};
    };
    await splitWorkbench(fake, workbenchCommand({node: '/bin/echo', cli: "/tmp/it's/cli.js"}), {});
    return input;
  };

  it('exec は1つだけ付き、先頭の空白で履歴に残さない', async () => {
    const input = await typed();
    expect(input).toBe(` exec '/bin/echo' '/tmp/it'\\''s/cli.js' workbench\n`);
    expect(input.match(/\bexec\b/g)).toHaveLength(1);
  });

  it.each(['bash', 'zsh', 'sh'])('%s でそのまま動く', async shell => {
    const input = await typed();
    const out = execFileSync(shell, ['-c', input], {encoding: 'utf8'});
    expect(out).toBe("/tmp/it's/cli.js workbench\n");
  });
});
