// 入力: 外部のコマンドを動かす。失敗しても例外を投げず、結果に含めて返す。

import {execFile} from 'node:child_process';

export interface RunResult {
  /** 終了コード。起動できなかったときやシグナルで終わったときは null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 起動できなかった理由(`ENOENT` など)。 */
  error?: string;
}

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  /** 標準入力に渡す文字列。 */
  input?: string;
}

export type Run = (cmd: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>;

export const run: Run = (cmd, args, opts = {}) =>
  new Promise(resolve => {
    const child = execFile(
      cmd,
      args as string[],
      {cwd: opts.cwd, timeout: opts.timeout ?? 30000, env: opts.env, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8'},
      (err, stdout, stderr) => {
        if (!err) return resolve({code: 0, stdout, stderr});
        const e = err as NodeJS.ErrnoException & {code?: number | string};
        if (typeof e.code === 'number') return resolve({code: e.code, stdout, stderr});
        resolve({code: null, stdout: stdout ?? '', stderr: stderr ?? '', error: String(e.code ?? e.message)});
      },
    );
    child.stdin?.end(opts.input ?? '');
  });

/** 制御列(色)を除く。 */
export function stripControl(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御列を除くため
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}
