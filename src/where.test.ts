import { describe, expect, it } from 'vitest';
import { vscodeDevUrl, vscodeFolderUrl } from './where.js';

describe('open targets', () => {
  it('maps a GitHub PR to vscode.dev', () => {
    expect(vscodeDevUrl('https://github.com/o/r/pull/12')).toBe('https://vscode.dev/github/o/r/pull/12');
    expect(vscodeDevUrl('https://ghe.example.com/o/r/pull/12')).toBeNull();
  });

  it('builds a VS Code folder URL', () => {
    expect(vscodeFolderUrl('/a/my repo')).toBe('vscode://file/a/my%20repo/');
  });
});
