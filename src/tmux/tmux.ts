// tmux: 専用の tmux サーバの操作(DESIGN.md「一覧と作業台の仕組み」「作業台の画面の仕組み」)。

import {spawn} from 'node:child_process';
import type {Run, RunResult} from '../input/exec.js';
import {ATTACH_KEYS, attachKeysHelp} from './keys.js';

export interface Client {
  tty: string;
  session: string;
  termname: string;
  pid: number;
}

export const LIST = 'list';
export const GUIDE = 'wbguide';

/** 利用者由来の文字列を tmux の書式に置くときは `#` を `##` にする。 */
export const escapeFormat = (s: string): string => s.replace(/#/g, '##');

/** シェルの単一引用符で囲む。 */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** キーとフックが呼ぶ小さな sh の本文(tmux のオプションに置き、動いている一覧と同じ版のものを使わせる)。 */
export function scripts(socket: string): Record<string, string> {
  const T = `tmux -L ${shq(socket)}`;
  return {
    // 頼みごとを書いてから一覧に知らせる。
    '@wn_req_sh': [
      `${T} set -g "@wn_req_$(date +%s)_$$" "$*"`,
      `p=$(${T} show -gv @wn_pid 2>/dev/null)`,
      `[ -n "$p" ] && kill -USR2 "$p" 2>/dev/null`,
      'exit 0',
    ].join('\n'),
    // 作業台の最後のシェルが終わったら、作業台の画面を案内へ切り替えてからセッションを畳む。
    '@wn_paned_sh': [
      's=$1; p=$2',
      'case "$s" in',
      'sh-*)',
      `  alive=$(${T} list-panes -s -t "=$s" -F '#{pane_dead}' 2>/dev/null | grep -c '^0$')`,
      '  if [ "$alive" -gt 0 ]; then',
      `    ${T} kill-pane -t "$p"`,
      '  else',
      `    wb=$(${T} show -gv @wn_wb_tty 2>/dev/null)`,
      `    ${T} set -g @wn_closed "\${s#sh-}"`,
      `    if [ -n "$wb" ] && ${T} list-clients -F '#{client_tty} #{client_session}' | grep -qx "$wb $s"; then`,
      `      ${T} switch-client -c "$wb" -t "=${GUIDE}"`,
      '    fi',
      `    ${T} kill-session -t "=$s"`,
      '  fi;;',
      `*) ${T} kill-pane -t "$p";;`,
      'esac',
      `q=$(${T} show -gv @wn_pid 2>/dev/null)`,
      `[ -n "$q" ] && kill -USR2 "$q" 2>/dev/null`,
      'exit 0',
    ].join('\n'),
    // claude の画面のステータス行の左(作業台の状態)。
    '@wn_wbstate_sh': [
      `${T} has-session -t "=sh-$1" 2>/dev/null || exit 0`,
      'out=""',
      `for pid in $(${T} list-panes -s -t "=sh-$1" -F '#{pane_pid}' 2>/dev/null); do`,
      '  tp=$(ps -o tpgid= -p "$pid" 2>/dev/null | tr -d " ")',
      '  if [ -n "$tp" ] && [ "$tp" != "$pid" ] && [ "$tp" -gt 0 ] 2>/dev/null; then',
      '    a=$(ps -o args= -p "$tp" 2>/dev/null)',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sh のパラメータ展開
      '    [ -n "$a" ] && out="${out:+$out · }$a"',
      '  fi',
      'done',
      'if [ -n "$out" ]; then printf "⚙ %s" "$out" | sed "s/#/##/g"; else printf "⌂ workbench (shell)"; fi',
    ].join('\n'),
  };
}

const callScript = (socket: string, name: string, args: string) =>
  `sh -c "$(tmux -L ${socket} show -gv ${name})" wn ${args} >/dev/null 2>&1; true`;

export interface ServerConfigInput {
  socket: string;
  listPid: number;
  version: string;
  env: Record<string, string>;
}

/** 一覧が `source-file -` で流し込む設定。 */
export function serverConfig(c: ServerConfigInput): string {
  const S = c.socket;
  const req = (args: string) => callScript(S, '@wn_req_sh', args);
  const lines: string[] = [
    'set -g prefix None',
    'set -g prefix2 None',
    'set -s escape-time 10',
    'set -s extended-keys on',
    'set -s extended-keys-format csi-u',
    'set -s focus-events on',
    'set -s set-clipboard on',
    'set -g history-limit 20000',
    'set -g detach-on-destroy on',
    'set -g remain-on-exit on',
    'set -g status off',
    'set -g mouse off',
    'set -g set-titles off',
    'set -g default-terminal tmux-256color',
    `set -g @wn_pid ${c.listPid}`,
    `set -g @wn_version '${c.version}'`,
    `set -g @wn_keys '${attachKeysHelp()}'`,
  ];
  for (const [k, v] of Object.entries(c.env)) lines.push(`set-environment -g ${k} '${v}'`);

  lines.push('unbind -a -T wnq', 'bind -n C-q switch-client -T wnq');
  for (const k of ATTACH_KEYS) {
    const cmd = `run-shell -b '${req(`key ${k.action} "#{session_name}" "#{client_tty}"`)}'`;
    lines.push(`bind -T wnq C-${k.letter} ${cmd}`, `bind -T prefix C-${k.letter} ${cmd}`);
    if (k.bare) lines.push(`bind -T wnq ${k.letter} ${cmd}`, `bind -T prefix ${k.letter} ${cmd}`);
  }

  const signal = `run-shell -b 'kill -USR2 ${c.listPid} 2>/dev/null; true'`;
  for (const h of ['client-session-changed', 'client-attached', 'client-detached', 'session-closed'])
    lines.push(`set-hook -g ${h} { ${signal} }`);
  lines.push(`set-hook -g client-focus-in { run-shell -b '${req('focus "#{client_tty}"')}' }`);
  lines.push(
    `set-hook -g pane-died { run-shell -b '${callScript(S, '@wn_paned_sh', '"#{session_name}" "#{pane_id}"')}' }`,
  );
  lines.push(
    `set-hook -g pane-title-changed { if -F '#{&&:#{@wn_claude},#{m:*claude agents*,#{pane_title}}}' { run-shell -b '${req('agentview "#{session_name}"')}' } }`,
  );
  // 一覧のセッションには root のキー表(C-q)を効かせない。
  lines.push(
    `set -t '=${LIST}:' key-table wnlist`,
    `set -w -t '=${LIST}:' remain-on-exit off`,
    `set -t '=${LIST}:' status off`,
  );
  return `${lines.join('\n')}\n`;
}

export interface MenuItem {
  label: string;
  key?: string;
  /** tmux のコマンド。選べない行は undefined。 */
  command?: string;
}

export class Tmux {
  constructor(
    readonly socket: string,
    private readonly run: Run,
  ) {}

  t(args: string[], input?: string): Promise<RunResult> {
    return this.run('tmux', ['-L', this.socket, ...args], {timeout: 10000, input});
  }

  /** 頼みごとを書く sh を呼ぶコマンド(メニューの項目などから)。 */
  reqCommand(args: string): string {
    return `run-shell -b '${callScript(this.socket, '@wn_req_sh', args)}'`;
  }

  async hasSession(name: string): Promise<boolean> {
    return (await this.t(['has-session', '-t', `=${name}`])).code === 0;
  }

  async sessions(): Promise<string[]> {
    const r = await this.t(['list-sessions', '-F', '#{session_name}']);
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  }

  async clients(): Promise<Client[]> {
    const r = await this.t([
      'list-clients',
      '-F',
      '#{client_tty}\t#{client_session}\t#{client_termname}\t#{client_pid}',
    ]);
    if (r.code !== 0) return [];
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map(l => {
        const [tty = '', session = '', termname = '', pid = '0'] = l.split('\t');
        return {tty, session, termname, pid: Number(pid)};
      });
  }

  async option(name: string): Promise<string | undefined> {
    const r = await this.t(['show', '-gv', name]);
    return r.code === 0 ? r.stdout.replace(/\n$/, '') : undefined;
  }

  async setOption(name: string, value: string): Promise<void> {
    await this.t(['set', '-g', name, value]);
  }

  async unsetOption(name: string): Promise<void> {
    await this.t(['set', '-gu', name]);
  }

  /** キーとフックが書いた頼みごとを、書かれた順に取り出して消す。 */
  async takeRequests(): Promise<string[]> {
    const r = await this.t(['show', '-g']);
    if (r.code !== 0) return [];
    const names = r.stdout
      .split('\n')
      .map(l => l.split(' ')[0] ?? '')
      .filter(n => n.startsWith('@wn_req_') && n !== '@wn_req_sh')
      .sort((a, b) => {
        const [, , as = '0'] = a.split('_');
        const [, , bs = '0'] = b.split('_');
        return Number(as) - Number(bs) || (a < b ? -1 : 1);
      });
    const out: string[] = [];
    for (const n of names) {
      const v = await this.option(n);
      await this.unsetOption(n);
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  async sourceConfig(text: string): Promise<RunResult> {
    const r = await this.t(['source-file', '-'], text);
    for (const [name, body] of Object.entries(scripts(this.socket))) await this.t(['set', '-g', name, body]);
    return r;
  }

  async switchClient(tty: string, target: string): Promise<boolean> {
    return (await this.t(['switch-client', '-c', tty, '-t', `=${target}`])).code === 0;
  }

  async detachClient(tty: string): Promise<void> {
    await this.t(['detach-client', '-t', tty]);
  }

  async killSession(name: string): Promise<void> {
    await this.t(['kill-session', '-t', `=${name}`]);
  }

  async killServer(): Promise<void> {
    await this.t(['kill-server']);
  }

  async display(tty: string, text: string, ms = 2000): Promise<void> {
    await this.t(['display-message', '-c', tty, '-d', String(ms), escapeFormat(text)]);
  }

  /** メニューを出す。閉じるまで戻らないので、終わりを待たない。 */
  menu(tty: string, title: string, items: MenuItem[]): void {
    const args = ['-L', this.socket, 'display-menu', '-c', tty, '-T', escapeFormat(title)];
    for (const it of items) {
      if (it.command === undefined) args.push(`-${escapeFormat(it.label)}`, '', '');
      else args.push(escapeFormat(it.label), it.key ?? '', it.command);
    }
    const child = spawn('tmux', args, {stdio: 'ignore', detached: true});
    child.on('error', () => {});
    child.unref();
  }

  /** claude の画面のセッション `<id>` を作る(すでにあれば作らない)。 */
  async ensureClaudeSession(id: string, cwd: string, size: {cols: number; rows: number}): Promise<boolean> {
    if (await this.hasSession(id)) return true;
    const T = `tmux -L ${shq(this.socket)}`;
    const cmd = [
      `claude attach ${shq(id)}`,
      'rc=$?',
      'if [ "$rc" -ne 0 ]; then',
      `  printf '\\n[claude attach exited with code %s. Press any key to return to the list.]' "$rc"`,
      '  stty raw -echo 2>/dev/null; dd bs=1 count=1 >/dev/null 2>&1; stty sane 2>/dev/null',
      'fi',
      `${T} switch-client -t '=${LIST}' 2>/dev/null`,
      'exit 0',
    ].join('\n');
    const r = await this.t([
      'new-session',
      '-d',
      '-s',
      id,
      '-c',
      cwd,
      '-x',
      String(size.cols),
      '-y',
      String(size.rows),
      `sh -c ${shq(cmd)}`,
      ';',
      'set',
      '-w',
      '-t',
      `=${id}:`,
      'remain-on-exit',
      'off',
    ]);
    if (r.code !== 0) return false;
    const S = this.socket;
    const t = `=${id}:`;
    const wbstate = `#(sh -c "$(tmux -L ${S} show -gv @wn_wbstate_sh)" wn #{session_name})`;
    await this.t([
      ...['set', '-t', t, '@wn_claude', '1', ';'],
      ...['set', '-t', t, 'status', '2', ';'],
      ...['set', '-t', t, 'status-interval', '3', ';'],
      ...['set', '-t', t, 'status-style', 'default', ';'],
      ...['set', '-t', t, 'status-left', wbstate, ';'],
      ...['set', '-t', t, 'status-left-length', '400', ';'],
      ...['set', '-t', t, 'status-format[0]', '#[align=left]#{=/#{e|-:#{client_width},1}/…:@wn_summary}', ';'],
      ...[
        'set',
        '-t',
        t,
        'status-format[1]',
        '#[align=left]#{T;=/#{e|/:#{client_width},3}/…:status-left}#[align=right]#[fg=colour8]#{=/#{e|-:#{e|-:#{client_width},#{e|/:#{client_width},3}},2}/…:@wn_keys}',
      ],
    ]);
    return true;
  }

  async setSummary(id: string, text: string): Promise<void> {
    await this.t(['set', '-t', `=${id}:`, '@wn_summary', escapeFormat(text)]);
  }

  /** 作業台 `sh-<id>` を作る。 */
  async createWorkbench(id: string, cwd: string, name: string): Promise<boolean> {
    const s = `sh-${id}`;
    const r = await this.t(['new-session', '-d', '-s', s, '-c', cwd]);
    if (r.code !== 0) return false;
    await this.workbenchOptions(s, name);
    return true;
  }

  async workbenchOptions(session: string, name: string): Promise<void> {
    const t = `=${session}:`;
    await this.t([
      ...['set', '-t', t, 'prefix', 'C-q', ';'],
      ...['set', '-t', t, 'mouse', 'on', ';'],
      ...['set', '-t', t, 'status', 'on', ';'],
      ...['set', '-t', t, 'status-interval', '3', ';'],
      ...['set', '-t', t, 'status-style', 'default', ';'],
      ...['set', '-t', t, 'set-titles', 'on', ';'],
      ...['set', '-t', t, 'set-titles-string', 'whatnext workbench', ';'],
      ...['set', '-t', t, '@wn_name', escapeFormat(name), ';'],
      ...[
        'set',
        '-t',
        t,
        'status-format[0]',
        session === GUIDE
          ? '#[align=left,fg=colour8]workbench: #{@wn_name}'
          : '#[align=left,fg=colour8]workbench: #{@wn_name}  #{W:#{window_index}:#{window_name}#{?window_active,*,} }',
      ],
    ]);
  }

  /** 信頼の確認を出すセッション(中で対話モードの `claude` が動く)。断って終わると一覧に戻す。 */
  async newTrustSession(dir: string): Promise<string | undefined> {
    const name = `trust-${Math.random().toString(36).slice(2, 8)}`;
    const T = `tmux -L ${shq(this.socket)}`;
    const cmd = `claude; ${T} switch-client -t '=${LIST}' 2>/dev/null; exit 0`;
    const r = await this.t([
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      dir,
      `sh -c ${shq(cmd)}`,
      ';',
      'set',
      '-w',
      '-t',
      `=${name}:`,
      'remain-on-exit',
      'off',
    ]);
    return r.code === 0 ? name : undefined;
  }

  async signalGuide(): Promise<void> {
    const pid = Number(await this.option('@wn_guide_pid'));
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGUSR2');
      } catch {}
    }
  }

  async setSessionName(session: string, name: string): Promise<void> {
    await this.t(['set', '-t', `=${session}:`, '@wn_name', escapeFormat(name)]);
  }

  /** 作業台ごとに、シェル以外で動いているもののコマンド行。 */
  async running(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const r = await this.t(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_dead}']);
    if (r.code !== 0) return out;
    const panes = r.stdout
      .split('\n')
      .filter(Boolean)
      .map(l => l.split('\t'))
      .filter(([s, , dead]) => s?.startsWith('sh-') && dead === '0');
    if (panes.length === 0) return out;
    const ps = await this.run('ps', ['-A', '-o', 'pid=,tpgid=,args='], {timeout: 5000});
    if (ps.code !== 0) return out;
    const procs = new Map<number, {tpgid: number; args: string}>();
    for (const line of ps.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
      if (m) procs.set(Number(m[1]), {tpgid: Number(m[2]), args: (m[3] as string).trim()});
    }
    for (const [s, pidText] of panes) {
      const pid = Number(pidText);
      const shell = procs.get(pid);
      if (!shell || shell.tpgid <= 0 || shell.tpgid === pid) continue;
      const fg = procs.get(shell.tpgid);
      if (!fg) continue;
      const id = (s as string).slice(3);
      out.set(id, [...(out.get(id) ?? []), fg.args]);
    }
    return out;
  }
}
