// 画面の通しの待つ補助。tmux に依らないので、振る舞いを単体のテスト(test/unit/e2e-until.test.ts)で確かめる(#352)。

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * `probe` の値が `ok` を満たすまで待つ。時間切れのときは、何を待っていたか(`what`)と最後の値を例外に出す。
 * `probe` が例外を出したときは、まだ満たさないとして待ち続け、最後の例外を時間切れの例外に含める
 * (ps の一時的な失敗で、時間切れを待たずに落ちないように)。期限を過ぎたら、もう一度だけ確かめてから時間切れにする
 * (期限の直前に満たされたのに、古い値で落ちないように)。
 */
export async function until(
  what: string,
  probe: () => string,
  ok: (v: string) => boolean,
  timeout = 8000,
  interval = 100,
): Promise<string> {
  const end = Date.now() + timeout;
  let v = '';
  let err: unknown;
  let failed = false;
  const check = (): boolean => {
    try {
      v = probe();
      failed = false;
    } catch (e) {
      err = e;
      failed = true;
      return false;
    }
    return ok(v);
  };
  while (Date.now() < end) {
    if (check()) return v;
    await sleep(interval);
  }
  if (check()) return v;
  const last = failed ? 'the probe threw' : `last value was: ${JSON.stringify(v)}`;
  const why = err === undefined ? '' : `; last probe error: ${err instanceof Error ? err.message : String(err)}`;
  throw new Error(`timed out after ${timeout}ms waiting for ${what}; ${last}${why}`, {cause: err});
}
