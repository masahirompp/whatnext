import {describe, expect, it} from 'vitest';
import {foregroundCommand, parsePs, serverConfig} from './tmux.js';

describe('作業台で動いているもの (シナリオ 30)', () => {
  const ps = [
    '  100     1   100   300 -sh',
    '  300   100   300   300 npm run e2e',
    '  301   300   300   300 node e2e.js',
    '  302   100   300   300 tee e2e.log',
    '  400     1   400   400 -sh',
  ].join('\n');

  it('パイプでつないだコマンドは、シェルの子で前面のものを | でつなぐ。シェルだけなら出さない', () => {
    const procs = parsePs(ps);
    expect(foregroundCommand(procs, 100)).toBe('npm run e2e | tee e2e.log');
    expect(foregroundCommand(procs, 400)).toBeUndefined();
  });
});

describe('専用サーバの設定', () => {
  const conf = serverConfig({
    socket: 'wn',
    listPid: 42,
    version: '1.2.3',
    env: {WHATNEXT_ROLE: 'list'},
    keys: [
      {letter: 'l', action: 'back', bare: false},
      {letter: 'v', action: 'vscode', bare: true},
    ],
    keysHelp: '^Q^L back · ^Q^V VS Code',
  });

  it('passthrough と端末の中継の設定を入れる(#268)', () => {
    expect(conf).toContain('set -g allow-passthrough on\n');
    expect(conf).not.toContain('allow-passthrough all');
    expect(conf).toContain('set -s focus-events on');
    expect(conf).toContain('set -s set-clipboard on');
    expect(conf).toContain('set -g history-limit 20000');
  });

  it('渡されたキーの表から ctrl+q のあとのキーを割り当てる', () => {
    expect(conf).toContain('bind -n C-q switch-client -T wnq');
    expect(conf).toMatch(/bind -T wnq C-l .*key back/);
    expect(conf).toMatch(/bind -T wnq C-v .*key vscode/);
    expect(conf).toMatch(/bind -T wnq v .*key vscode/);
    expect(conf).not.toMatch(/bind -T wnq l /);
    expect(conf).toContain("set -g @wn_keys '^Q^L back · ^Q^V VS Code'");
    expect(conf).toContain('set -g @wn_pid 42');
    expect(conf).toContain("set-environment -g WHATNEXT_ROLE 'list'");
  });
});
