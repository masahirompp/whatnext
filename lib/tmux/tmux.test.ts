import {execFileSync} from 'node:child_process';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {foregroundCommand, GUIDE, GUIDE_PANE, parsePs, scripts, serverConfig, workbenchStatusFormat} from './tmux.js';

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

describe('作業台のステータス行 (シナリオ 49)', () => {
  it('作業台ではウィンドウの一覧のあとに分割とウィンドウのキーを続け、% は %% と書く', () => {
    expect(workbenchStatusFormat('sh-a0000000')).toMatch(
      /workbench: #\{@wn_name\} {2}#\{W:.*\} · \^Q%% split │ · \^Q" split ─ · \^Qc window$/,
    );
  });

  it('案内のセッションにはセッション名だけを出す', () => {
    expect(workbenchStatusFormat(GUIDE)).toBe('#[align=left,fg=colour8]workbench: #{@wn_name}');
  });
});

describe('ペインが終わったときの処理', () => {
  const body = scripts('wn')['@wn_paned_sh'] ?? '';

  it('sh の文法として正しい', () => {
    for (const [name, b] of Object.entries(scripts('wn'))) {
      expect(() => execFileSync('sh', ['-n', '-c', b]), name).not.toThrow();
    }
  });

  /**
   * 偽の tmux(呼ばれた引数を記録し、`@wn_respawned` には `stored` を、印には `marked` なら 1 を、
   * ペインの一覧には終わったペインと、`otherAlive` なら生きたペインを返す)で、
   * 案内のセッションのペインが終わったときの処理を動かす。
   */
  const runGuideDied = (stored: string, marked = true, otherAlive = true): string[] => {
    const dir = mkdtempSync(join(tmpdir(), 'wn-paned-'));
    try {
      const log = join(dir, 'calls.log');
      writeFileSync(
        join(dir, 'tmux'),
        [
          '#!/bin/sh',
          `echo "$*" >> ${JSON.stringify(log)}`,
          'case "$*" in',
          `  *show*@wn_respawned*) printf '%s' ${JSON.stringify(stored)};;`,
          `  *show*${GUIDE_PANE}*) ${marked ? 'echo 1' : 'true'};;`,
          `  *list-panes*) printf '1\\n${otherAlive ? '0\\n' : ''}';;`,
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(join(dir, 'tmux'), 0o755);
      execFileSync('sh', ['-c', body, 'wn', GUIDE, '%7'], {env: {...process.env, PATH: `${dir}:${process.env.PATH}`}});
      return readFileSync(log, 'utf8').split('\n').filter(Boolean);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  };
  const now = () => Math.floor(Date.now() / 1000);

  it('案内のペインは畳まずに起動し直し、終わったときの様子を残す', () => {
    const calls = runGuideDied('');
    expect(calls).toContainEqual(expect.stringMatching(/^-L wn set -p -t %7 @wn_respawned 1 \d+$/));
    expect(calls).toContain('-L wn respawn-pane -t %7');
    expect(calls).not.toContainEqual(expect.stringMatching(/kill-pane/));
    expect(calls).toContainEqual(expect.stringMatching(/^-L wn set -g @wn_guide_died /));
  });

  it('60秒以内に続けて5回起動し直したあとにまた終わったら、畳まずに死んだペインのまま残す', () => {
    const calls = runGuideDied(`5 ${now() - 10}`);
    expect(calls).not.toContain('-L wn respawn-pane -t %7');
    expect(calls).not.toContainEqual(expect.stringMatching(/kill-pane/));
  });

  it('前の起動し直しから60秒を過ぎていれば、数え直して起動し直す', () => {
    const calls = runGuideDied(`5 ${now() - 120}`);
    expect(calls).toContainEqual(expect.stringMatching(/^-L wn set -p -t %7 @wn_respawned 1 \d+$/));
    expect(calls).toContain('-L wn respawn-pane -t %7');
  });

  it('案内のセッションでも、印のないペイン(利用者が分割したもの)は閉じる', () => {
    const calls = runGuideDied('', false);
    expect(calls).toContain('-L wn kill-pane -t %7');
    expect(calls).not.toContain('-L wn respawn-pane -t %7');
  });

  it('印のないペインでも、案内のセッションの最後の生きたペインなら閉じずに残す', () => {
    const calls = runGuideDied('', false, false);
    expect(calls).not.toContainEqual(expect.stringMatching(/kill-pane|respawn-pane/));
  });
});
