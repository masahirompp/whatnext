import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import type {Run} from '../../lib/input/exec.js';
import {splitWorkbench, tabWorkbench} from '../../lib/tmux/ghostty.js';
import {workbenchCommand} from '../../src/cli/env.js';

// Ghostty の分割とタブに打ち込む `whatnext workbench`(ADR-0015)。一覧が渡すコマンドを `splitWorkbench` と `tabWorkbench` に通した文字列を確かめる。

describe.each([
  ['split', splitWorkbench],
  ['tab', tabWorkbench],
] as const)('Ghostty の分割とタブに打ち込むコマンド(%s)', (done, open) => {
  const typed = async (): Promise<string> => {
    const inputs: string[] = [];
    // osascript の引数のうち、打ち込む文字列は改行で終わるもの(並びには頼らない)
    const fake: Run = async (_cmd, args) => {
      inputs.push(...args.filter(a => a.endsWith('\n') && !a.includes('tell application')));
      return {code: 0, stdout: `${done}\n`, stderr: ''};
    };
    await open(fake, workbenchCommand({node: '/bin/echo', cli: "/tmp/it's/cli.js"}), {});
    expect(inputs).toHaveLength(1);
    return inputs[0] ?? '';
  };

  it('exec は1つだけ付く', async () => {
    expect((await typed()).match(/\bexec\b/g)).toHaveLength(1);
  });

  // zsh(macOS での利用者のシェル)で動くことは、実機の通し test/real/ghostty.test.ts の 58a/58b が本物の Ghostty で確かめる。
  // ここでは zsh のない環境でも回る bash と sh だけを動かす(#311 の `exec exec` は bash で落ちる)。
  it.each(['bash', 'sh'])('%s でそのまま動く', async shell => {
    expect(execFileSync(shell, ['-c', await typed()], {encoding: 'utf8'})).toBe("/tmp/it's/cli.js workbench\n");
  });
});
