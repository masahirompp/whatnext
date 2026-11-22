import {describe, expect, it} from 'vitest';
import {until} from '../e2e/until.js';

// 画面の通しの待つ補助(#352)。tmux に依らないので、ここで振る舞いを確かめる
describe('画面の通しの until', () => {
  it('満たされたらその値で戻る', async () => {
    let n = 0;
    const v = await until(
      'n to reach 3',
      () => String(++n),
      v => v === '3',
      2000,
      10,
    );
    expect(v).toBe('3');
  });

  it('probe が例外を出しても待ち続け、満たされたら戻る', async () => {
    let n = 0;
    const probe = () => {
      n++;
      if (n < 3) throw new Error('ps failed');
      return 'ok';
    };
    await expect(until('ok', probe, v => v === 'ok', 2000, 10)).resolves.toBe('ok');
    expect(n).toBe(3);
  });

  it('期限の直前に満たされたら成功する(期限のあとにもう一度確かめる)', async () => {
    // 間(100ms)が期限(50ms)より長いので、ループの中で確かめるのは最初の1回だけ。満たすのは期限を過ぎてから
    const end = Date.now() + 50;
    let n = 0;
    const probe = () => {
      n++;
      return Date.now() >= end ? 'ready' : 'not yet';
    };
    await expect(until('ready', probe, v => v === 'ready', 50, 100)).resolves.toBe('ready');
    expect(n).toBe(2);
  });

  it('時間切れの例外に、待っていたものと最後の値が入る', async () => {
    const waiting = until(
      'the answer',
      () => 'no',
      v => v === 'yes',
      50,
      10,
    );
    await expect(waiting).rejects.toThrow(/timed out after 50ms waiting for the answer; last value was: "no"/);
  });

  it('時間切れの例外に、最後の probe の例外が入る', async () => {
    let n = 0;
    const probe = () => {
      throw new Error(`ps failed ${++n}`);
    };
    const err = await until('ok', probe, () => true, 50, 10).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/waiting for ok; the probe threw; last probe error: ps failed \d+$/);
    expect((err as Error).message).toContain(`ps failed ${n}`);
    expect((err as Error).cause).toBeInstanceOf(Error);
  });
});
