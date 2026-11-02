import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {workbenchCommand} from '../../src/cli/env.js';

// Ghostty の分割に打ち込む `whatnext workbench`(ADR-0015)。`splitWorkbench` は ` exec <command>` を打ち込む(lib の契約)。

describe('Ghostty の分割に打ち込むコマンド', () => {
  const typed = ` exec ${workbenchCommand({node: '/bin/echo', cli: "/tmp/it's/cli.js"})}\n`;

  it('一覧が渡すコマンドには exec を付けない', () => {
    expect(typed.match(/\bexec\b/g)).toHaveLength(1);
  });

  it.each(['bash', 'zsh', 'sh'])('%s でそのまま動く', shell => {
    expect(execFileSync(shell, ['-c', typed], {encoding: 'utf8'})).toBe("/tmp/it's/cli.js workbench\n");
  });
});
