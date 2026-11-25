// 起動の引数(PRODUCT.md「全体」)。

export const USAGE = `Usage: whatnext [--no-digest | --help]
       whatnext workbench
       whatnext new <directory|repository> "<prompt>"

A terminal list of your parallel Claude Code sessions, grouped by repository.

  whatnext              Open the list (or come back to the one that is running). The sessions you start with n
                        send their digests (Goal, Progress, Next) and links to the list.
                        Each turn end of those sessions makes one Haiku call.
  whatnext --no-digest  Open the list without digests. The sessions you start with n make no Haiku call.
  whatnext workbench    Show the workbench shell of the session you are looking at (run it in a split)
  whatnext new <directory|repository> "<prompt>"
                        Start a background session with the prompt and print its id, without opening the list.
                        Works without a terminal (scripts, launchers). The session is set up like one started
                        with n. <repository> is the end of a path in "ghq list -p" (name, owner/name).
                        Pass the prompt as one argument (quote it).
  --help                Show this help
`;

export type Parsed =
  | {cmd: 'help'}
  | {cmd: 'workbench'}
  | {cmd: 'list'; digest: boolean}
  | {cmd: 'new'; target: string; prompt: string}
  /** `whatnext new` の引数が足りない、多い、空(使い方を出して終了コード 1)。`many` は、引数が多いとき(指示を引用符で囲み忘れた)。 */
  | {cmd: 'new-usage'; many: boolean}
  | {cmd: 'bad'; arg: string};

/** 引数を振り分ける。`--help` は先頭の引数にあるときだけ。`--no-digest` は一覧を開くときだけ(ほかの引数と組まない)。
 * ダイジェストは既定で有効で、`--no-digest` で切る(ADR-0023)。`new` は、ディレクトリかリポジトリ名と、指示の2つを取る
 * (指示は1つの引数。空白を含むなら、呼ぶ側が引用符で囲む)。ディレクトリかリポジトリ名は、前後の空白を切って渡す(`n` の
 * 入力と同じ)。`new` のあとの `--help` は、`workbench --help` と同じく知らないオプションにする(指示が `--help` のセッションを
 * 起動しない)。 */
export function parseArgs(args: readonly string[]): Parsed {
  if (args[0] === '--help') return {cmd: 'help'};
  if (args.length === 0) return {cmd: 'list', digest: true};
  if (args[0] === '--no-digest' && args.length === 1) return {cmd: 'list', digest: false};
  if (args[0] === 'workbench' && args.length === 1) return {cmd: 'workbench'};
  if (args[0] === 'new') {
    if (args.slice(1).includes('--help')) return {cmd: 'bad', arg: '--help'};
    const [, target = '', prompt = ''] = args;
    if (args.length !== 3 || !target.trim() || !prompt.trim()) return {cmd: 'new-usage', many: args.length > 3};
    return {cmd: 'new', target: target.trim(), prompt};
  }
  const bad = args[0] === 'workbench' || args[0] === '--no-digest' ? args[1] : args[0];
  return {cmd: 'bad', arg: bad};
}
