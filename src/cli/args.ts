// 起動の引数(PRODUCT.md「全体」)。

export const USAGE = `Usage: whatnext [--no-digest | --help]
       whatnext workbench

A terminal list of your parallel Claude Code sessions, grouped by repository.

  whatnext              Open the list (or come back to the one that is running). The sessions you start with n
                        send their digests (Goal, Progress, Next) and links to the list.
                        Each turn end of those sessions makes one Haiku call.
  whatnext --no-digest  Open the list without digests. The sessions you start with n make no Haiku call.
  whatnext workbench    Show the workbench shell of the session you are looking at (run it in a split)
  --help                Show this help
`;

/** 引数を振り分ける。`--help` は先頭の引数にあるときだけ。`--no-digest` は一覧を開くときだけ(ほかの引数と組まない)。
 * ダイジェストは既定で有効で、`--no-digest` で切る(ADR-0023)。 */
export function parseArgs(
  args: readonly string[],
): {cmd: 'help'} | {cmd: 'workbench'} | {cmd: 'list'; digest: boolean} | {cmd: 'bad'; arg: string} {
  if (args[0] === '--help') return {cmd: 'help'};
  if (args.length === 0) return {cmd: 'list', digest: true};
  if (args[0] === '--no-digest' && args.length === 1) return {cmd: 'list', digest: false};
  if (args[0] === 'workbench' && args.length === 1) return {cmd: 'workbench'};
  const bad = args[0] === 'workbench' || args[0] === '--no-digest' ? args[1] : args[0];
  return {cmd: 'bad', arg: bad};
}
