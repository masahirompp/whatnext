import {describe, expect, it} from 'vitest';
import {sessionFailureLines} from '../../src/ops/app.js';

// claude --bg が開けなかったときの失敗の画面(#320)。起動できなかった理由(run の結果の error)を出す。

const HEAD = 'claude --bg did not start a session:';

describe('claude --bg が開けなかったときの失敗の画面', () => {
  it('PATH に claude がないとき(起動する場所はある)、claude がないと出す', () => {
    expect(sessionFailureLines('', 'ENOENT', true)).toEqual([HEAD, 'claude not found on PATH (ENOENT)']);
  });
  it('起動する場所が消えていたとき、ENOENT を claude がないとは言わない', () => {
    expect(sessionFailureLines('', 'ENOENT', false)).toEqual([HEAD, 'the directory no longer exists (ENOENT)']);
  });
  it('起動できなかった理由がそれ以外のときも、その理由を出す', () => {
    expect(sessionFailureLines('', 'EACCES')).toEqual([HEAD, 'EACCES']);
  });
  it('理由が出力を含むとき(時間切れ)は、理由の最初の行だけを出し、出力と重ねない', () => {
    const out = 'partial output\n';
    expect(sessionFailureLines(out, `Command failed: claude --bg\n${out}`)).toEqual([
      HEAD,
      'Command failed: claude --bg',
      'partial output',
    ]);
  });
  it('出力があるときは、今までどおり出力を並べる', () => {
    expect(sessionFailureLines('something went wrong\n')).toEqual([HEAD, 'something went wrong']);
  });
});
