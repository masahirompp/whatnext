import {describe, expect, it} from 'vitest';
import {App} from '../../src/ops/app.js';
import type {Ports, RunResult} from '../../src/ops/ports.js';

// claude --bg が開けなかったときの失敗の画面(#320)。起動できなかった理由(run の結果の error)を出す。

const appWithRun = async (result: RunResult): Promise<string[]> => {
  const p: Ports = {
    run: async () => result,
    tmux: {} as Ports['tmux'],
    observer: {} as Ports['observer'],
    locations: {} as Ports['locations'],
    prs: {} as Ports['prs'],
    transcripts: {} as Ports['transcripts'],
    hooks: {} as Ports['hooks'],
    stateFile: {} as Ports['stateFile'],
    fetchUsage: async () => undefined,
    now: () => 0,
    write: () => {},
    size: () => ({cols: 80, rows: 24}),
    digest: false,
    socket: 'wn-test',
    port: 0,
    version: 'test',
    workbenchCommand: 'whatnext workbench',
    guideCommand: 'whatnext guide',
    launchDir: '/tmp',
    claudeJson: '/tmp/claude.json',
    home: '/tmp',
    log: () => {},
    exit: () => {},
  } as unknown as Ports;
  const app = new App(p);
  // 単体では描かない(描画は test/e2e の画面の通しで確かめる)
  (app as unknown as {draw: () => void}).draw = () => {};
  await (app as unknown as {startSession: (dir: string) => Promise<void>}).startSession('/tmp/app');
  const mode = (app as unknown as {mode: {k: string; lines?: string[]}}).mode;
  return mode.lines ?? [];
};

describe('claude --bg が開けなかったときの失敗の画面', () => {
  it('PATH に claude がないとき、理由を出す(#320)', async () => {
    const lines = await appWithRun({code: null, stdout: '', stderr: '', error: 'ENOENT'});
    expect(lines[0]).toBe('claude --bg did not start a session:');
    expect(lines).toContain('claude not found on PATH (ENOENT)');
  });
  it('起動できなかった理由がそれ以外のときも、その理由を出す', async () => {
    const lines = await appWithRun({code: null, stdout: '', stderr: '', error: 'EACCES'});
    expect(lines).toContain('EACCES');
  });
  it('出力があるときは、今までどおり出力を並べる', async () => {
    const lines = await appWithRun({code: 1, stdout: '', stderr: 'something went wrong'});
    expect(lines).toEqual(['claude --bg did not start a session:', 'something went wrong']);
  });
});
