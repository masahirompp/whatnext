import {accessSync, constants, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {launchSettings, type Occupant} from '../../lib/input/receiver.js';
import type {Attachments} from '../ops/start.js';
import {modDir} from './env.js';

// 起動するセッションに何を付けるか(フックと OTel、ダイジェストの mod)。一覧の `n`(`list.ts`)と `whatnext new`
// (`new.ts`)の判断を、ここだけに置く(DESIGN.md「一覧の外からの起動」)。

export type Launcher =
  /** 一覧。`opened` は受け口を自分で開けられたか、`digest` はダイジェストが有効か。 */
  | {who: 'list'; opened: boolean; digest: boolean}
  /** `whatnext new`。受け口は開けず、動いている一覧か、あとで開く一覧に届ける。 */
  | {who: 'new'};

/**
 * 受け口のポートの状態から、付けるものを決める。
 * - 一覧: 受け口を自分で開けたときだけフックと OTel を付け、ダイジェストが有効なら mod も付ける
 * - `whatnext new`: ポートをほかのプログラムが使っているとき(`other`)だけ何も付けない。一覧が動いているとき(`whatnext`)も、
 *   動いていないとき(`free`)も、フックと OTel と mod を付ける。一覧が `--no-digest` かは見ない(受けていない間、mod は
 *   Haiku を呼ばない)
 */
export function decideAttachments(occupant: Occupant, by: Launcher): {hooks: boolean; mod: boolean} {
  if (by.who === 'list') {
    const hooks = occupant === 'free' && by.opened;
    return {hooks, mod: hooks && by.digest};
  }
  const hooks = occupant !== 'other';
  return {hooks, mod: hooks};
}

/** 決めたものを `claude --bg` に渡す形にする。mod の環境(`digestEnv`)は、呼ぶ側が `withDigestEnv` で足す。 */
export function attachmentsFor(port: number, want: {hooks: boolean; mod: boolean}): Attachments {
  return {
    settings: want.hooks ? launchSettings(port) : undefined,
    pluginDir: want.mod ? modDir() : undefined,
  };
}

/**
 * ダイジェストの mod が読む環境(送る先のポート、受けているかを確かめる tmux と専用サーバのソケット)。
 * ソケットのパスが分からなければ足さない(mod は `-L whatnext` を使う)。
 */
export function digestEnv(port: number, socketPath: string | undefined, tmux = findTmux()): Record<string, string> {
  return {
    WHATNEXT_DIGEST_PORT: String(port),
    WHATNEXT_DIGEST_TMUX: tmux,
    ...(socketPath ? {WHATNEXT_DIGEST_SOCKET: socketPath} : {}),
  };
}

/** `--settings` の JSON の `env` に、ダイジェストの mod が読む値(送る先のポート、受けているかを確かめる tmux)を足す。 */
export function withDigestEnv(settings: string, add: Record<string, string>): string {
  try {
    const j = JSON.parse(settings) as {env?: Record<string, string>};
    j.env = {...(j.env ?? {}), ...add};
    return JSON.stringify(j);
  } catch {
    return settings;
  }
}

/** tmux の実行ファイルの絶対パス(`claude --bg` のセッションの PATH に tmux があるとは限らない)。なければ `tmux`。 */
export function findTmux(path = process.env.PATH ?? ''): string {
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const p = join(dir, 'tmux');
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return 'tmux';
}

/**
 * 専用サーバのソケットのパスを、サーバに問い合わせずに組む(一覧が動いていなくても決まる)。tmux は、`-L <名前>` のソケットを
 * `TMUX_TMPDIR`(なければ `/tmp`)の実パスの下の `tmux-<uid>/<名前>` に置く(tmux 3.7c の `#{socket_path}` で確かめた。#381)。
 */
export function socketPathOf(
  socket: string,
  pe: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
): string | undefined {
  if (uid === undefined) return undefined;
  const dir = pe.TMUX_TMPDIR || '/tmp';
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {}
  return join(real, `tmux-${uid}`, socket);
}
